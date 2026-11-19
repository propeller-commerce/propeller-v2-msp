import { classifyTransaction } from '../src/msp/statusLadder';
import {
  PaymentStatuses,
  TransactionTypes,
  TransactionStatuses,
} from '@propeller-commerce/propeller-sdk-v2';
import { OrderStatus } from '../src/enums';

describe('classifyTransaction — the MultiSafepay webhook status ladder', () => {
  it.each(['completed', 'reserved', 'shipped'])(
    '%s → PAID / NEW, fulfil',
    (status) => {
      const out = classifyTransaction({ status })!;
      expect(out.transactionType).toBe(TransactionTypes.PAY);
      expect(out.transactionStatus).toBe(TransactionStatuses.SUCCESS);
      expect(out.paymentStatus).toBe(PaymentStatuses.PAID);
      expect(out.orderStatus).toBe(OrderStatus.NEW);
      expect(out.deleteCart).toBe(true);
    }
  );

  it('initialized → OPEN / UNFINISHED, no fulfil (plugin parity)', () => {
    const out = classifyTransaction({ status: 'initialized' })!;
    expect(out.transactionStatus).toBe(TransactionStatuses.OPEN);
    expect(out.paymentStatus).toBe(PaymentStatuses.OPEN);
    expect(out.orderStatus).toBe(OrderStatus.UNFINISHED);
    expect(out.deleteCart).toBe(false);
  });

  it('uncleared → PENDING / UNFINISHED, no fulfil (plugin parity)', () => {
    const out = classifyTransaction({ status: 'uncleared' })!;
    expect(out.transactionStatus).toBe(TransactionStatuses.PENDING);
    expect(out.paymentStatus).toBe(PaymentStatuses.PENDING);
    expect(out.orderStatus).toBe(OrderStatus.UNFINISHED);
    expect(out.deleteCart).toBe(false);
  });

  it('declined → FAILED / UNFINISHED, no fulfil', () => {
    const out = classifyTransaction({ status: 'declined' })!;
    expect(out.transactionStatus).toBe(TransactionStatuses.FAILED);
    expect(out.paymentStatus).toBe(PaymentStatuses.FAILED);
    expect(out.orderStatus).toBe(OrderStatus.UNFINISHED);
    expect(out.deleteCart).toBe(false);
  });

  it.each(['cancelled', 'canceled', 'void'])(
    '%s → CANCELLED / UNFINISHED, no fulfil',
    (status) => {
      const out = classifyTransaction({ status })!;
      expect(out.paymentStatus).toBe(PaymentStatuses.CANCELLED);
      expect(out.orderStatus).toBe(OrderStatus.UNFINISHED);
      expect(out.deleteCart).toBe(false);
    }
  );

  it('expired → EXPIRED / UNFINISHED, no fulfil', () => {
    const out = classifyTransaction({ status: 'expired' })!;
    expect(out.paymentStatus).toBe(PaymentStatuses.EXPIRED);
    expect(out.orderStatus).toBe(OrderStatus.UNFINISHED);
    expect(out.deleteCart).toBe(false);
  });

  it.each(['refunded', 'partial_refunded'])(
    '%s → REFUND txn, PAID / NEW, fulfil (plugin omitted partial — we handle it)',
    (status) => {
      const out = classifyTransaction({ status })!;
      expect(out.transactionType).toBe(TransactionTypes.REFUND);
      expect(out.transactionStatus).toBe(TransactionStatuses.SUCCESS);
      expect(out.paymentStatus).toBe(PaymentStatuses.PAID);
      expect(out.orderStatus).toBe(OrderStatus.NEW);
      expect(out.deleteCart).toBe(true);
    }
  );

  it('chargedback → CHARGEBACK txn, CHARGEBACK / NEW, fulfil (plugin omitted — we handle it)', () => {
    const out = classifyTransaction({ status: 'chargedback' })!;
    expect(out.transactionType).toBe(TransactionTypes.CHARGEBACK);
    expect(out.transactionStatus).toBe(TransactionStatuses.SUCCESS);
    expect(out.paymentStatus).toBe(PaymentStatuses.CHARGEBACK);
    expect(out.orderStatus).toBe(OrderStatus.NEW);
    expect(out.deleteCart).toBe(true);
  });

  it('is case-insensitive on the status string', () => {
    expect(classifyTransaction({ status: 'COMPLETED' })!.paymentStatus).toBe(PaymentStatuses.PAID);
  });

  it('returns null for an unrecognised status', () => {
    expect(classifyTransaction({ status: 'weird' })).toBeNull();
    expect(classifyTransaction({ status: '' })).toBeNull();
  });
});
