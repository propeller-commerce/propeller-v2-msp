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
import {
  setPropellerOrderStatus,
  fetchOrderTotal,
  routeOrderLookupToOrderEditorKey,
} from './propeller/orders';
import { toCents, matchesOrderTotal } from './propeller/amounts';
import { OrderStatus } from './enums';
import { PaymentStatuses, TransactionTypes } from '@propeller-commerce/propeller-sdk-v2';
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
   *
   * Changes nothing unless MultiSafepay's amount and currency match the order's
   * VAT-inclusive total (`order.total.net`); the confirmation mail, PDF and
   * cart deletion only run while the order is still UNFINISHED and the outcome
   * changes its status or pay status, so a replay doesn't repeat them. Once
   * the order is placed, only a paid outcome (a no-op when it's already PAID),
   * a refund or a chargeback is written; nothing moves it back to UNFINISHED.
   * Anyone can call the webhook URL with any order id, so verify the `Auth`
   * header first with `verifyWebhookSignature` (POST notifications only).
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

      // 3. Tie the payment to the order before touching either. The order id
      //    and amount came from the checkout request, so a payment of one cent
      //    against someone else's order must not mark it PAID / NEW, send its
      //    confirmation or clear its cart.
      //    Only a payment of the order's own total, in its currency, counts.
      routeOrderLookupToOrderEditorKey(this.client);
      const order = await fetchOrderTotal(this.client, fetched.orderId);
      if (!order) {
        this.log('error', `Webhook: transaction ${transactionId} points at order ${fetched.orderId}, which was not found; nothing changed`);
        return {
          ok: false,
          paymentId: transactionId,
          orderId: fetched.orderId,
          mspStatus: fetched.snapshot.status,
          error: 'order not found',
        };
      }
      if (!matchesOrderTotal(fetched.amountCents, fetched.currency, order.total, order.currency)) {
        this.log(
          'error',
          `Webhook: transaction ${transactionId} (${fetched.amountCents} cents ${fetched.currency}) does not match the total of order ${fetched.orderId} (${order.total} ${order.currency}); order and payment left unchanged`
        );
        return {
          ok: false,
          paymentId: transactionId,
          orderId: fetched.orderId,
          mspStatus: fetched.snapshot.status,
          error: 'amount does not match the order total',
        };
      }

      // 4. A placed order (no longer UNFINISHED) can't be reopened by a
      //    transaction. An initialized/uncleared/declined/cancelled/void/expired
      //    outcome (e.g. a stale or replayed notification) writes nothing, and
      //    a paid replay on a PAID order is a no-op. Refunds and chargebacks
      //    still apply.
      const placed = order.status.toUpperCase() !== OrderStatus.UNFINISHED;
      if (placed && outcome.orderStatus === OrderStatus.UNFINISHED) {
        this.log(
          'warn',
          `Webhook: transaction ${transactionId} is ${fetched.snapshot.status} but order ${fetched.orderId} is already ${order.status}; nothing changed`
        );
        return {
          ok: false,
          paymentId: transactionId,
          orderId: fetched.orderId,
          mspStatus: fetched.snapshot.status,
          error: `order is already ${order.status}; ${fetched.snapshot.status} transaction ignored`,
        };
      }
      if (
        placed &&
        outcome.transactionType === TransactionTypes.PAY &&
        order.payStatus.toUpperCase() === PaymentStatuses.PAID
      ) {
        this.log('info', `Webhook: order ${fetched.orderId} is already PAID; ${transactionId} needs no update`);
        return {
          ok: true,
          paymentId: transactionId,
          orderId: fetched.orderId,
          mspStatus: fetched.snapshot.status,
        };
      }

      // 5. Update the Propeller payment (+ append transaction). Use MultiSafepay's
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

      // 6. Update the Propeller order status. The confirmation mail, PDF, event
      //    and cart deletion run only while the order is UNFINISHED and the
      //    outcome changes it (out of UNFINISHED, or to another pay status), so
      //    a replayed notification or a later refund doesn't send the
      //    confirmation again. initialized/uncleared never fulfil (ladder).
      const changesOrder =
        outcome.orderStatus !== OrderStatus.UNFINISHED ||
        order.payStatus.toUpperCase() !== outcome.paymentStatus;
      await setPropellerOrderStatus(this.client, {
        orderId: fetched.orderId,
        orderStatus: outcome.orderStatus,
        payStatus: outcome.paymentStatus,
        fulfil: outcome.deleteCart && !placed && changesOrder,
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
   * Verify a MultiSafepay notification before passing it to `handleWebhook`,
   * using the API key this provider is configured with (`testApiKey` when
   * `testMode`, else `liveApiKey`).
   *
   * @param rawBody The exact raw request body, before any JSON parsing.
   * @param authHeader The `Auth` request header.
   * @param validationWindowSeconds Max age (and max future skew) of the signed
   *   timestamp in seconds (default 600; a value <= 0 uses the default).
   * @returns true only for a present, fresh, matching signature. A GET
   *   notification has no body or `Auth` header and never verifies.
   */
  verifyWebhookSignature(
    rawBody: string,
    authHeader: string | null | undefined,
    validationWindowSeconds = 600
  ): boolean {
    return this.gateway.verifySignature(rawBody, authHeader, validationWindowSeconds);
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
 * Note: this is the CLIENT/return-page rule and is distinct from the WEBHOOK's
 * `deleteCart` in `statusLadder.ts`, the server-side rule for the *backend*
 * cart. Both keep the cart on initialized/uncleared, as the WordPress plugin does.
 *
 * Exported for testing and for hosts that want the same rule without a network
 * round-trip.
 */
export function isSettledStatus(status: string): boolean {
  const s = (status || '').toLowerCase();
  return s === 'completed' || s === 'reserved' || s === 'shipped';
}
