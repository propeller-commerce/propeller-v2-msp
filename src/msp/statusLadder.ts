/**
 * The MultiSafepay webhook status ladder.
 *
 * MultiSafepay's webhook posts a `transactionid` (the Propeller order id we sent
 * as `order_id`); we re-fetch the transaction (`GET /json/orders/{id}`) and map
 * its `status` to the Propeller status tuple. This mirrors the `switch` in the
 * WordPress plugin's `webhook.php`, but with two deliberate corrections:
 *
 *  1. The plugin's switch does NOT handle `partial_refunded` or `chargedback`
 *     (they fall through with everything unset — a latent bug). We handle both.
 *  2. We branch on a small, version-stable snapshot (`{ status }`) so this file
 *     is pure and trivially unit-testable.
 *
 * Full MultiSafepay status set:
 *   completed | initialized | uncleared | reserved | declined | cancelled
 *   | void | expired | refunded | partial_refunded | chargedback | shipped
 * @see https://docs.multisafepay.com/docs/statuses
 */

import { PaymentStatuses } from '@propeller-commerce/propeller-sdk-v2';
import { TransactionTypes } from '@propeller-commerce/propeller-sdk-v2';
import { TransactionStatuses } from '@propeller-commerce/propeller-sdk-v2';
import { OrderStatus, OrderStatusValue } from '../enums';

/**
 * The version-stable subset of a MultiSafepay transaction we need to classify
 * it. `status` is MultiSafepay's canonical order status string.
 */
export interface MspTransactionSnapshot {
  /** MultiSafepay status: completed | initialized | uncleared | reserved |
   *  declined | cancelled | void | expired | refunded | partial_refunded |
   *  chargedback | shipped */
  status: string;
}

export interface PropellerStatusOutcome {
  transactionType: TransactionTypes;
  transactionStatus: TransactionStatuses;
  paymentStatus: PaymentStatuses;
  orderStatus: OrderStatusValue;
  /** Whether the originating cart should be cleared + confirmation email sent. */
  deleteCart: boolean;
}

/**
 * Classify a MultiSafepay transaction into the Propeller status tuple.
 *
 * Mirrors `webhook.php` (with the two corrections noted above):
 *  - completed  → PAID / NEW, clear cart                 (money captured)
 *  - reserved   → PAID / NEW, clear cart                 (plugin treats as paid)
 *  - initialized→ PENDING / UNFINISHED, clear cart       (awaiting payment)
 *  - uncleared  → PENDING / UNFINISHED, clear cart       (awaiting manual review)
 *  - shipped    → PAID / NEW, clear cart                 (post-fulfilment)
 *  - declined   → FAILED / UNFINISHED
 *  - cancelled  → CANCELLED / UNFINISHED
 *  - void       → CANCELLED / UNFINISHED
 *  - expired    → EXPIRED / UNFINISHED
 *  - refunded   → REFUND txn, PAID / NEW, clear cart
 *  - partial_refunded → REFUND txn, PAID / NEW, clear cart
 *  - chargedback→ CHARGEBACK txn, CHARGEBACK / NEW, clear cart
 *
 * Returns `null` for an unrecognised state (caller logs and no-ops rather than
 * push a wrong status).
 */
export function classifyTransaction(
  snapshot: MspTransactionSnapshot
): PropellerStatusOutcome | null {
  const status = (snapshot.status ?? '').toLowerCase();

  switch (status) {
    // Money captured — fulfil the order.
    case 'completed':
    case 'reserved':
    case 'shipped':
      return {
        transactionType: TransactionTypes.PAY,
        transactionStatus: TransactionStatuses.SUCCESS,
        paymentStatus: PaymentStatuses.PAID,
        orderStatus: OrderStatus.NEW,
        deleteCart: true,
      };

    // Awaiting payment / manual clearing — order not final yet.
    case 'initialized':
      return {
        transactionType: TransactionTypes.PAY,
        transactionStatus: TransactionStatuses.OPEN,
        paymentStatus: PaymentStatuses.OPEN,
        orderStatus: OrderStatus.UNFINISHED,
        deleteCart: true,
      };
    case 'uncleared':
      return {
        transactionType: TransactionTypes.PAY,
        transactionStatus: TransactionStatuses.PENDING,
        paymentStatus: PaymentStatuses.PENDING,
        orderStatus: OrderStatus.UNFINISHED,
        deleteCart: true,
      };

    // Failure states — keep the cart so the shopper can retry.
    case 'declined':
      return {
        transactionType: TransactionTypes.PAY,
        transactionStatus: TransactionStatuses.FAILED,
        paymentStatus: PaymentStatuses.FAILED,
        orderStatus: OrderStatus.UNFINISHED,
        deleteCart: false,
      };
    case 'cancelled':
    case 'canceled':
    case 'void':
      return {
        transactionType: TransactionTypes.PAY,
        transactionStatus: TransactionStatuses.FAILED,
        paymentStatus: PaymentStatuses.CANCELLED,
        orderStatus: OrderStatus.UNFINISHED,
        deleteCart: false,
      };
    case 'expired':
      return {
        transactionType: TransactionTypes.PAY,
        transactionStatus: TransactionStatuses.FAILED,
        paymentStatus: PaymentStatuses.EXPIRED,
        orderStatus: OrderStatus.UNFINISHED,
        deleteCart: false,
      };

    // Refund / chargeback — the plugin omitted the partial/chargeback arms; we
    // handle them explicitly.
    case 'refunded':
    case 'partial_refunded':
      return {
        transactionType: TransactionTypes.REFUND,
        transactionStatus: TransactionStatuses.SUCCESS,
        paymentStatus: PaymentStatuses.PAID,
        orderStatus: OrderStatus.NEW,
        deleteCart: true,
      };
    case 'chargedback':
      return {
        transactionType: TransactionTypes.CHARGEBACK,
        transactionStatus: TransactionStatuses.SUCCESS,
        paymentStatus: PaymentStatuses.CHARGEBACK,
        orderStatus: OrderStatus.NEW,
        deleteCart: true,
      };

    default:
      return null;
  }
}
