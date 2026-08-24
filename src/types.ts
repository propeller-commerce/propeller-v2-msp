/**
 * Public types for the MultiSafepay provider.
 */

import type { GraphQLClient } from '@propeller-commerce/propeller-sdk-v2';
import type { Logger } from './logger';

/**
 * The three PSP inputs — the headline constructor argument.
 *
 * The active key is selected by `testMode`: `key = testMode ? testApiKey : liveApiKey`.
 * `testMode` ALSO selects the base URL (MultiSafepay has separate live/test
 * hosts), unlike Mollie where the key alone implied the environment.
 */
export interface MspProviderConfig {
  /** MultiSafepay LIVE API key. Used when `testMode` is false (→ api.multisafepay.com). */
  liveApiKey: string;
  /** MultiSafepay TEST API key. Used when `testMode` is true (→ testapi.multisafepay.com). */
  testApiKey: string;
  /** When true, the test key + test host are used; when false, live. */
  testMode: boolean;
  /** Optional locale appended to every request (default `'en_US'`). */
  locale?: string;
}

/**
 * Host wiring — everything the package needs that isn't a PSP secret.
 *
 * The host injects a ready-configured SDK `GraphQLClient`. IMPORTANT: that
 * client must be built with `orderEditorApiKey` set (and `securityMode:
 * 'direct'` for server-to-server use), or the order-status mutations
 * (`orderSetStatus`, `triggerOrderSendConfirm`) will auth-fail — see README.
 */
export interface MspProviderHost {
  /** A configured Propeller SDK GraphQL client (host-owned, server-side). */
  client: GraphQLClient;
  /**
   * Public URL MultiSafepay will POST notifications to. MultiSafepay calls this
   * with `?transactionid=<orderId>` after an order changes state. Must be
   * reachable from the public internet (MultiSafepay cannot reach `localhost`).
   */
  webhookUrl: string;
  /** Optional logger. Defaults to a `console`-backed logger. */
  logger?: Logger;
}

/** Arguments to start a payment at checkout. */
export interface CreatePaymentArgs {
  /** Propeller order id this payment is for (sent as MultiSafepay `order_id`). */
  orderId: number;
  /** Amount in MAJOR units (e.g. `10` or `"10.00"` for ten euros). */
  amount: string | number;
  /** ISO 4217 currency code, e.g. `"EUR"`. */
  currency: string;
  /** Propeller payment-method code (mapped to a MultiSafepay gateway code). */
  method: string;
  /** Human-readable description shown to the shopper / in MultiSafepay. */
  description: string;
  /** Where MultiSafepay returns the shopper after payment (your thank-you / status page). */
  redirectUrl: string;
  /** Where MultiSafepay returns the shopper on cancel. Defaults to `redirectUrl`. */
  cancelUrl?: string;
  /** Logged-in user id, if any. One of `userId` / `anonymousId` should be set. */
  userId?: number;
  /** Guest user id, if any. */
  anonymousId?: number;
}

/** Result of `createPayment`. */
export interface CreatePaymentResult {
  /** MultiSafepay hosted checkout URL — redirect the shopper here. */
  checkoutUrl: string;
  /**
   * The payment id to persist / poll by. For MultiSafepay this is the order id
   * (MSP keys transactions by `order_id`); it is what the webhook and the
   * status lookup re-fetch by.
   */
  paymentId: string;
  /** The Propeller order id. */
  orderId: number;
}

/**
 * Canonical MultiSafepay order status values. A redirected shopper's order is in
 * one of these states.
 * @see https://docs.multisafepay.com/docs/statuses
 */
export type MspPaymentStatus =
  | 'initialized'
  | 'completed'
  | 'uncleared'
  | 'reserved'
  | 'declined'
  | 'cancelled'
  | 'void'
  | 'expired'
  | 'refunded'
  | 'partial_refunded'
  | 'chargedback'
  | 'shipped';

/** Result of `getPaymentStatus`. */
export interface PaymentStatusResult {
  /** Whether the MultiSafepay order was found / fetched successfully. */
  ok: boolean;
  /** MultiSafepay order/payment id queried (= the Propeller order id). */
  paymentId: string;
  /** The live MultiSafepay status (e.g. 'completed', 'declined'), if fetched. */
  status?: MspPaymentStatus;
  /** Local-cart hint for the return page: true only for a captured payment
   *  (`completed`/`reserved`/`shipped`) → clear the cart. False for
   *  `initialized`/`uncleared` (not resolved yet → keep the cart) and
   *  `declined`/`cancelled`/`void`/`expired` (keep it for a retry). See
   *  `isSettledStatus`. */
  settled?: boolean;
  /** Propeller order id echoed by MultiSafepay, if present. */
  orderId?: number;
  /** Populated when `ok` is false. */
  error?: string;
}

/** Result of `handleWebhook`. Always resolves; never throws out of the webhook. */
export interface HandleWebhookResult {
  /** Whether the order was found, classified, and Propeller updated. */
  ok: boolean;
  /** MultiSafepay order/payment id processed. */
  paymentId: string;
  /** Propeller order id resolved from the transaction, if available. */
  orderId?: number;
  /** MultiSafepay status string at processing time, if fetched. */
  mspStatus?: string;
  /** Populated when `ok` is false. */
  error?: string;
}
