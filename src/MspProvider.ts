/**
 * MspProvider — the public entry point.
 *
 * Drives MultiSafepay PSP payments through the Propeller GraphQL API. Two
 * operations:
 *
 *   1. `createPayment(args)` — create a MultiSafepay order + a Propeller payment,
 *      and return the MultiSafepay checkout URL to redirect the shopper to.
 *   2. `handleWebhook(transactionId)` — called from the host's webhook route.
 *      Re-fetches the order from MultiSafepay (never trusts the request body
 *      beyond the id), classifies it, and updates the Propeller payment + order.
 *
 * MultiSafepay keys transactions by `order_id` (which we set to the Propeller
 * order id), so — unlike the Mollie provider — there is no separate `tr_...`
 * payment id and no metadata round-trip: the id we persist, poll, and re-fetch
 * by IS the order id, and MultiSafepay echoes it natively.
 *
 * Transport-agnostic: the host owns the HTTP route and must always respond 200
 * to MultiSafepay. `handleWebhook` therefore NEVER throws — it returns a result
 * object and logs internally, so a downstream error can't turn into a non-2xx
 * that makes MultiSafepay retry forever.
 */

import { MspGateway } from './msp/client';
import { resolveMspGateway } from './msp/methodMap';
import { classifyTransaction } from './msp/statusLadder';
import { createPropellerPayment, updatePropellerPayment } from './propeller/payments';
import { setPropellerOrderStatus } from './propeller/orders';
import { toCents } from './propeller/amounts';
import { consoleLogger, type Logger } from './logger';
import type {
  MspProviderConfig,
  MspProviderHost,
  CreatePaymentArgs,
  CreatePaymentResult,
  HandleWebhookResult,
  MspPaymentStatus,
  PaymentStatusResult,
} from './types';
import type { GraphQLClient } from '@propeller-commerce/propeller-sdk-v2';

export class MspProvider {
  private readonly gateway: MspGateway;
  private readonly client: GraphQLClient;
  private readonly webhookUrl: string;
  private readonly log: Logger;

  /**
   * @param config The PSP inputs: `{ liveApiKey, testApiKey, testMode, locale? }`.
   * @param host   Host wiring: a configured SDK `GraphQLClient` (built with
   *               `orderEditorApiKey` + `securityMode: 'direct'`), the public
   *               `webhookUrl`, and an optional `logger`.
   */
  constructor(config: MspProviderConfig, host: MspProviderHost) {
    if (!host?.client) {
      throw new Error('MspProvider: host.client (a Propeller SDK GraphQLClient) is required.');
    }
    if (!host.webhookUrl) {
      throw new Error('MspProvider: host.webhookUrl is required (MultiSafepay must POST somewhere public).');
    }
    this.gateway = new MspGateway(config);
    this.client = host.client;
    this.webhookUrl = host.webhookUrl;
    this.log = host.logger ?? consoleLogger;
  }

  /**
   * Start a payment: create a MultiSafepay order, persist a Propeller payment
   * (status OPEN with an AUTHORIZATION transaction), and return the checkout URL.
   *
   * Throws on failure — payment creation happens during the shopper's checkout
   * request, where the host wants to surface the error (unlike the webhook).
   */
  async createPayment(args: CreatePaymentArgs): Promise<CreatePaymentResult> {
    const gateway = resolveMspGateway(args.method);

    this.log('info', `Creating MultiSafepay order ${args.orderId} (gateway=${gateway ?? 'selector'})`);

    const created = await this.gateway.createOrder({
      orderId: args.orderId,
      amount: toCents(args.amount),
      currency: args.currency,
      description: args.description,
      redirectUrl: args.redirectUrl,
      cancelUrl: args.cancelUrl ?? args.redirectUrl,
      notificationUrl: this.webhookUrl,
      gateway,
      userId: args.userId,
    });

    if (!created.paymentUrl) {
      throw new Error(
        `MultiSafepay order ${created.orderId} has no payment URL (gateway=${gateway ?? 'selector'}).`
      );
    }

    // The id we persist and re-fetch by is the MultiSafepay order id (= the
    // Propeller order id echoed by MSP).
    const paymentId = created.orderId;

    // Persist in Propeller (status OPEN + AUTHORIZATION transaction).
    await createPropellerPayment(this.client, {
      paymentId,
      orderId: args.orderId,
      amount: args.amount,
      currency: args.currency,
      method: args.method,
      userId: args.userId,
      anonymousId: args.anonymousId,
    });

    this.log('info', `MultiSafepay order ${paymentId} created`);

    return {
      checkoutUrl: created.paymentUrl,
      paymentId,
      orderId: args.orderId,
    };
  }

  /**
   * Handle a MultiSafepay notification. Pass the `transactionid` MultiSafepay
   * sent (which is the order id). Re-fetches the order, classifies it, updates
   * the Propeller payment + order. Always resolves (never throws) so the host
   * can unconditionally return 200.
   */
  async handleWebhook(transactionId: string): Promise<HandleWebhookResult> {
    if (!transactionId) {
      this.log('warn', 'Webhook called without a transaction id');
      return { ok: false, paymentId: '', error: 'missing transaction id' };
    }

    try {
      // 1. Re-fetch from MultiSafepay — never trust the request body beyond the id.
      const fetched = await this.gateway.getOrderSnapshot(transactionId);

      this.log(
        'info',
        `Webhook: order ${transactionId} status=${fetched.snapshot.status} propellerOrder=${fetched.orderId ?? 'n/a'}`
      );

      if (fetched.orderId === undefined) {
        this.log('error', `Webhook: order ${transactionId} has no order_id in response`);
        return {
          ok: false,
          paymentId: transactionId,
          mspStatus: fetched.snapshot.status,
          error: 'missing order_id in transaction',
        };
      }
      if (fetched.amountCents === undefined || fetched.currency === undefined) {
        this.log('error', `Webhook: order ${transactionId} missing amount/currency`);
        return {
          ok: false,
          paymentId: transactionId,
          orderId: fetched.orderId,
          mspStatus: fetched.snapshot.status,
          error: 'missing amount/currency in transaction',
        };
      }

      // 2. Classify the MultiSafepay state into the Propeller status tuple.
      const outcome = classifyTransaction(fetched.snapshot);
      if (!outcome) {
        this.log('warn', `Webhook: unhandled MultiSafepay status "${fetched.snapshot.status}" for ${transactionId}`);
        return {
          ok: false,
          paymentId: transactionId,
          orderId: fetched.orderId,
          mspStatus: fetched.snapshot.status,
          error: `unhandled status: ${fetched.snapshot.status}`,
        };
      }

      // 3. Update the Propeller payment (+ append transaction). Use MultiSafepay's
      //    authoritative amount/currency, not a client-supplied value. Amount is
      //    returned in cents; payments.ts re-applies toCents, so pass MAJOR units.
      await updatePropellerPayment(this.client, {
        paymentId: transactionId,
        amount: fetched.amountCents / 100,
        currency: fetched.currency,
        paymentStatus: outcome.paymentStatus,
        transactionType: outcome.transactionType,
        transactionStatus: outcome.transactionStatus,
      });

      // 4. Update the Propeller order status (+ confirm/clear-cart on fulfil).
      await setPropellerOrderStatus(this.client, {
        orderId: fetched.orderId,
        orderStatus: outcome.orderStatus,
        payStatus: outcome.paymentStatus,
        fulfil: outcome.deleteCart,
      });

      this.log(
        'info',
        `Webhook: processed ${transactionId} → payment=${outcome.paymentStatus}, order=${outcome.orderStatus}`
      );

      return {
        ok: true,
        paymentId: transactionId,
        orderId: fetched.orderId,
        mspStatus: fetched.snapshot.status,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log('error', `Webhook: error processing ${transactionId}: ${message}`, err);
      // Swallow — the host still returns 200; MultiSafepay will retry, and a
      // transient failure recovers on the next delivery without a poison-retry loop.
      return { ok: false, paymentId: transactionId, error: message };
    }
  }

  /**
   * Fetch the live MultiSafepay status for an order id. Read-only — does NOT
   * touch Propeller. Intended for the return page so the UI can reflect the real
   * outcome (initialized / completed / declined / …) without waiting on, or
   * being misled by, the async notification + order status.
   *
   * `settled` is the local-cart-deletion hint: true only for captured states
   * (`completed`/`reserved`/`shipped` → clear the cart). It is false for
   * `initialized`/`uncleared` (not resolved yet → keep the cart in sync with the
   * live backend cart) and for `declined`/`cancelled`/`void`/`expired` (keep it
   * so the shopper can retry). Always resolves.
   */
  async getPaymentStatus(orderId: string): Promise<PaymentStatusResult> {
    if (!orderId) {
      return { ok: false, paymentId: '', error: 'missing order id' };
    }
    try {
      const fetched = await this.gateway.getOrderSnapshot(orderId);
      const status = fetched.snapshot.status as MspPaymentStatus;
      return {
        ok: true,
        paymentId: orderId,
        status,
        settled: isSettledStatus(status),
        orderId: fetched.orderId,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log('error', `getPaymentStatus: error for ${orderId}: ${message}`, err);
      return { ok: false, paymentId: orderId, error: message };
    }
  }
}

/**
 * Whether a MultiSafepay status means the shopper's LOCAL cart should be cleared
 * on the return page — i.e. the payment is actually captured and the order is
 * being finalized. Only `completed` / `reserved` / `shipped` qualify.
 *
 * `initialized` / `uncleared` deliberately return false: the payment isn't
 * resolved yet and the order is still UNFINISHED, so the host must KEEP the
 * local cart in sync with the still-live backend cart (clearing it early lets a
 * subsequent "add to cart" silently reuse the same un-finalized order).
 * `declined` / `cancelled` / `void` / `expired` also return false so the shopper
 * can retry.
 *
 * Note: this is the CLIENT/return-page rule and is intentionally distinct from
 * the WEBHOOK's `deleteCart` in `statusLadder.ts`, which is a faithful port of
 * the WordPress plugin and clears the *backend* cart on initialized/uncleared too.
 *
 * Exported for testing and for hosts that want the same rule without a network
 * round-trip.
 */
export function isSettledStatus(status: string): boolean {
  const s = (status || '').toLowerCase();
  return s === 'completed' || s === 'reserved' || s === 'shipped';
}
