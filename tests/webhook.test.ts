/**
 * handleWebhook ties the MultiSafepay transaction to the Propeller order
 * (review #19): nothing changes unless MSP's amount + currency pay the order's
 * total. A real SDK GraphQLClient and the real MspGateway run against a stubbed
 * `fetch`, so the key routing of the order lookup is exercised too.
 */
import { createHmac } from 'crypto';
import { GraphQLClient } from '@propeller-commerce/propeller-sdk-v2';
import { MspProvider } from '../src/MspProvider';
import { MSP_TEST_URL } from '../src/msp/client';
import { noopLogger } from '../src/logger';
import { ORDER_TOTAL_OPERATION, routeOrderLookupToOrderEditorKey } from '../src/propeller/orders';

type Order = {
  id: number;
  status: string;
  currency: string;
  total: { net: number };
  paymentData: { status: string };
} | null;
type Call = { operationName: string; variables: Record<string, any>; apikey: string };

let mspOrder: { order_id: number; status: string; amount: number; currency: string };
let order: Order;
let calls: Call[];
let mspCreateBody: any;

beforeEach(() => {
  mspOrder = { order_id: 42, status: 'completed', amount: 200000, currency: 'EUR' };
  order = placedOrder('UNFINISHED', 'OPEN');
  calls = [];
  mspCreateBody = undefined;
  jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).startsWith(MSP_TEST_URL)) {
      if (init?.method === 'POST') {
        mspCreateBody = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({ success: true, data: { order_id: 42, payment_url: 'https://pay.test/x' } })
        );
      }
      return new Response(JSON.stringify({ success: true, data: mspOrder }));
    }
    const body = JSON.parse(String(init?.body));
    const apikey = (init?.headers as Record<string, string>).apikey;
    calls.push({ operationName: body.operationName, variables: body.variables, apikey });
    if (body.operationName === 'orderSetStatus' && order) {
      // Apply the write, so a replay sees the order as Propeller would return it.
      order.status = body.variables.input.status;
      order.paymentData.status = body.variables.input.payStatus;
    }
    const data =
      body.operationName === ORDER_TOTAL_OPERATION
        ? order
          ? { order }
          : null
        : { [body.operationName]: { id: 1 } };
    const errors = data ? undefined : [{ message: 'Cannot find order with id 42' }];
    return new Response(JSON.stringify({ data, errors }));
  });
});

function placedOrder(status: string, payStatus: string): Order {
  return { id: 42, status, currency: 'EUR', total: { net: 2000 }, paymentData: { status: payStatus } };
}

function provider(): MspProvider {
  const client = new GraphQLClient({
    endpoint: 'https://propeller.test/graphql',
    apiKey: 'storefront-key',
    orderEditorApiKey: 'order-editor-key',
    securityMode: 'direct',
    orderEditorMutations: ['orderSetStatus', 'paymentCreate', 'paymentUpdate'],
  });
  return new MspProvider(
    { liveApiKey: 'live_key', testApiKey: 'test_key', testMode: true },
    { client, webhookUrl: 'https://shop.test/api/msp/webhook', logger: noopLogger }
  );
}

const writes = () => calls.filter((c) => c.operationName !== ORDER_TOTAL_OPERATION);
const setStatus = () => calls.find((c) => c.operationName === 'orderSetStatus');

describe('handleWebhook — transaction must pay the order total', () => {
  it('matching amount + currency: PAID / NEW with confirmation, lookup under the order-editor key', async () => {
    const res = await provider().handleWebhook('42');
    expect(res.ok).toBe(true);
    const lookup = calls.find((c) => c.operationName === ORDER_TOTAL_OPERATION)!;
    expect(lookup.variables).toEqual({ orderId: 42 });
    expect(lookup.apikey).toBe('order-editor-key');
    expect(setStatus()!.variables.input).toMatchObject({
      orderId: 42,
      status: 'NEW',
      payStatus: 'PAID',
      sendOrderConfirmationEmail: true,
      deleteCart: true,
    });
  });

  it('amount below the total: nothing written', async () => {
    mspOrder.amount = 1;
    const res = await provider().handleWebhook('42');
    expect(res).toMatchObject({ ok: false, orderId: 42, error: 'amount does not match the order total' });
    expect(writes()).toEqual([]);
  });

  it('initialized transaction of a foreign amount does not clear the cart', async () => {
    mspOrder.status = 'initialized';
    mspOrder.amount = 500;
    const res = await provider().handleWebhook('42');
    expect(res.ok).toBe(false);
    expect(writes()).toEqual([]);
  });

  it('currency mismatch: nothing written', async () => {
    mspOrder.currency = 'USD';
    const res = await provider().handleWebhook('42');
    expect(res).toMatchObject({ ok: false, error: 'amount does not match the order total' });
    expect(writes()).toEqual([]);
  });

  it('missing order: nothing written', async () => {
    order = null;
    const res = await provider().handleWebhook('42');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Cannot find order/);
    expect(writes()).toEqual([]);
  });

  it('placed but unpaid order (NEW, OPEN): paid is written, no second confirmation or cart deletion', async () => {
    order = placedOrder('NEW', 'OPEN');
    const res = await provider().handleWebhook('42');
    expect(res.ok).toBe(true);
    expect(setStatus()!.variables.input).toMatchObject({
      status: 'NEW',
      payStatus: 'PAID',
      sendOrderConfirmationEmail: false,
      addPDFAttachment: false,
      triggerOrderSendConfirmEvent: false,
      deleteCart: false,
    });
  });
});

describe('handleWebhook — a placed order is never moved back', () => {
  beforeEach(() => {
    order = placedOrder('NEW', 'PAID');
  });

  it.each(['initialized', 'uncleared', 'declined', 'cancelled', 'void', 'expired'])(
    '%s transaction of the order total on a NEW + PAID order: nothing written',
    async (status) => {
      mspOrder.status = status;
      const res = await provider().handleWebhook('42');
      expect(res).toMatchObject({ ok: false, orderId: 42, error: `order is already NEW; ${status} transaction ignored` });
      expect(writes()).toEqual([]);
    }
  );

  it('expired transaction on a later-stage order (CONFIRMED): nothing written', async () => {
    order = placedOrder('CONFIRMED', 'PAID');
    mspOrder.status = 'expired';
    await provider().handleWebhook('42');
    expect(writes()).toEqual([]);
  });

  it.each(['completed', 'reserved', 'shipped'])('%s replay on a PAID order: nothing re-sent or re-written', async (status) => {
    mspOrder.status = status;
    const res = await provider().handleWebhook('42');
    expect(res).toMatchObject({ ok: true, orderId: 42 });
    expect(writes()).toEqual([]);
  });

  // Unchanged: refunded / partial_refunded append a REFUND transaction and keep
  // NEW / PAID; chargedback appends a CHARGEBACK transaction and sets pay status
  // CHARGEBACK. Neither re-sends the confirmation or touches the cart of a
  // placed order.
  it.each([
    ['refunded', 'REFUND', 'PAID'],
    ['partial_refunded', 'REFUND', 'PAID'],
    ['chargedback', 'CHARGEBACK', 'CHARGEBACK'],
  ])('%s on a NEW + PAID order: %s transaction, pay status %s, no confirmation', async (status, txn, pay) => {
    mspOrder.status = status;
    const res = await provider().handleWebhook('42');
    expect(res.ok).toBe(true);
    const payment = writes().find((c) => c.operationName !== 'orderSetStatus')!;
    expect(payment.variables.input.addTransaction).toMatchObject({ type: txn, status: 'SUCCESS' });
    expect(setStatus()!.variables.input).toMatchObject({
      status: 'NEW',
      payStatus: pay,
      sendOrderConfirmationEmail: false,
      deleteCart: false,
    });
  });
});

describe('handleWebhook — a replayed waiting status never fulfils', () => {
  const fulfils = () =>
    calls.filter((c) => c.operationName === 'orderSetStatus' && c.variables.input.sendOrderConfirmationEmail)
      .length;

  it.each(['initialized', 'uncleared'])('3x %s then 2x completed: one fulfil, for completed', async (status) => {
    order = placedOrder('UNFINISHED', '');
    const p = provider();
    mspOrder.status = status;
    for (let i = 0; i < 3; i++) await p.handleWebhook('42');
    expect(fulfils()).toBe(0);
    expect(setStatus()!.variables.input).toMatchObject({ status: 'UNFINISHED', deleteCart: false });

    mspOrder.status = 'completed';
    await p.handleWebhook('42');
    expect(fulfils()).toBe(1);
    const lastSetStatus = calls.filter((c) => c.operationName === 'orderSetStatus').pop()!;
    expect(lastSetStatus.variables.input).toMatchObject({ status: 'NEW', payStatus: 'PAID', deleteCart: true });
    await p.handleWebhook('42');
    expect(fulfils()).toBe(1);
  });
});

describe('routeOrderLookupToOrderEditorKey', () => {
  it('fallback for a client without orderEditorMutations never adds passwordResetLink', async () => {
    const client = new GraphQLClient({
      endpoint: 'https://propeller.test/graphql',
      apiKey: 'storefront-key',
      orderEditorApiKey: 'order-editor-key',
      securityMode: 'direct',
    });
    routeOrderLookupToOrderEditorKey(client);
    expect(client.getConfig().orderEditorMutations).toEqual([
      'orderSetStatus',
      'triggerQuoteSendRequest',
      'triggerOrderSendConfirm',
      ORDER_TOTAL_OPERATION,
    ]);
    await client.execute({ query: 'mutation passwordResetLink { x }', operationName: 'passwordResetLink' });
    expect(calls.find((c) => c.operationName === 'passwordResetLink')!.apikey).toBe('storefront-key');
  });
});

describe('notification signature', () => {
  it('orders are created with POST notifications, so they carry the Auth header', async () => {
    await provider().createPayment({
      orderId: 42,
      amount: 2000,
      currency: 'EUR',
      method: 'ideal',
      description: 'Order 42',
      redirectUrl: 'https://shop.test/thanks',
    });
    expect(mspCreateBody.payment_options).toMatchObject({
      notification_url: 'https://shop.test/api/msp/webhook',
      notification_method: 'POST',
    });
  });

  it('provider.verifyWebhookSignature uses the active (test) API key', () => {
    const body = '{"order_id":42,"status":"completed"}';
    const ts = Math.floor(Date.now() / 1000);
    const sign = (key: string) =>
      Buffer.from(
        `${ts}:${createHmac('sha512', key).update(`${ts}:${body}`).digest('hex')}`
      ).toString('base64');
    expect(provider().verifyWebhookSignature(body, sign('test_key'))).toBe(true);
    expect(provider().verifyWebhookSignature(body, sign('live_key'))).toBe(false);
    expect(provider().verifyWebhookSignature('', null)).toBe(false);
  });
});
