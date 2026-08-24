# @propeller-commerce/propeller-v2-msp

MultiSafepay PSP payment provider for the **Propeller eCommerce V2** platform.
Drives MultiSafepay payments through the Propeller GraphQL API via
[`@propeller-commerce/propeller-sdk-v2`](https://www.npmjs.com/package/@propeller-commerce/propeller-sdk-v2).

This is a **server-side, framework-agnostic** library: it creates MultiSafepay
orders, persists them in Propeller, reconciles order/payment state from the
MultiSafepay notification, and exposes a live status lookup for the return page.
The **host** owns the HTTP layer (the checkout route, the webhook route, and the
return/thank-you page).

It talks to the MultiSafepay JSON API over the global `fetch` — **zero PSP
runtime dependencies** (Node 18+).

> ⚠️ **Server-only.** This package handles secret MultiSafepay API keys and
> issues privileged Propeller mutations. Never bundle it into browser code.

## Install

```bash
npm install @propeller-commerce/propeller-v2-msp @propeller-commerce/propeller-sdk-v2
```

`@propeller-commerce/propeller-sdk-v2` is a **peer dependency** — the host
provides the configured GraphQL client.

## The inputs

```ts
new MspProvider(
  { liveApiKey, testApiKey, testMode, locale? },  // ← the PSP inputs
  { client, webhookUrl, logger? }                 // ← host wiring
);
```

| Input | Meaning |
|---|---|
| `liveApiKey` | MultiSafepay **live** API key. Used when `testMode` is `false` (→ `api.multisafepay.com`). |
| `testApiKey` | MultiSafepay **test** API key. Used when `testMode` is `true` (→ `testapi.multisafepay.com`). |
| `testMode` | `true` → test key + test host, `false` → live. |
| `locale` | Optional; appended to every request. Defaults to `en_US`. |

> Unlike Mollie (where the key implies the environment), MultiSafepay has
> **separate live/test hosts**, so `testMode` selects both the key *and* the
> base URL.

## Host wiring (`client`, `webhookUrl`, `logger`)

The package does **not** build a Propeller client and holds **no** Propeller
credentials — you inject a configured SDK `GraphQLClient`.

```ts
import { GraphQLClient } from '@propeller-commerce/propeller-sdk-v2';

const client = new GraphQLClient({
  endpoint: process.env.PROPELLER_GRAPHQL_ENDPOINT!,
  apiKey: process.env.PROPELLER_API_KEY!,
  orderEditorApiKey: process.env.PROPELLER_ORDER_EDITOR_API_KEY!, // ← REQUIRED, see below
  securityMode: 'direct',
});
```

> ### ❗ You MUST set `orderEditorApiKey`
> In `direct` mode the SDK routes order-editor mutations — **`orderSetStatus`**
> and **`triggerOrderSendConfirm`** — to the `orderEditorApiKey` header instead
> of `apiKey`. This package updates order status on every notification, so
> **without `orderEditorApiKey` the order-status update silently auth-fails**
> while the payment update appears to succeed. Always supply it. (Some hosts
> also extend the SDK's `orderEditorMutations` list to include `paymentCreate` /
> `paymentUpdate` — do that if your setup routes those through the order-editor
> key.)

`webhookUrl` is the **public** URL MultiSafepay will POST notifications to
(MultiSafepay cannot reach `localhost`; use a tunnel like cloudflared or ngrok
in development). `logger` is optional and defaults to a `console`-backed logger.

## Usage

### 1. Start a payment (checkout)

Creates the MultiSafepay order **and** the Propeller payment (status `OPEN` + an
`AUTHORIZATION` transaction), then returns the MultiSafepay checkout URL.

```ts
import { MspProvider } from '@propeller-commerce/propeller-v2-msp';

const provider = new MspProvider(
  {
    liveApiKey: process.env.MSP_LIVE_KEY!,
    testApiKey: process.env.MSP_TEST_KEY!,
    testMode: process.env.MSP_TEST_MODE === 'true',
  },
  { client, webhookUrl: `${process.env.PUBLIC_BASE_URL}/api/msp/webhook` }
);

const { checkoutUrl, paymentId } = await provider.createPayment({
  orderId: 12345,
  amount: '49.95',         // major units (number or decimal string)
  currency: 'EUR',
  method: 'ideal',         // Propeller method code → mapped to a MultiSafepay gateway
  description: 'Order #12345',
  redirectUrl: `${process.env.PUBLIC_BASE_URL}/checkout/thank-you/12345`,
  userId: 678,             // or anonymousId for guests
});

// `paymentId` is the MultiSafepay order id (= the Propeller order id). Stash it
// for the return page, then redirect the shopper to `checkoutUrl`.
```

> **MultiSafepay keys everything by `order_id`.** There is no separate `tr_...`
> id: `paymentId` is the order id, and the webhook + status lookup re-fetch by
> it. MultiSafepay echoes `order_id` natively, so there is no metadata dance.

### 2. Handle the webhook

MultiSafepay POSTs to your `notification_url` with `?transactionid=<orderId>`.
Pass that id to `handleWebhook`; it re-fetches the order from MultiSafepay (the
body is never trusted beyond the id), classifies it, and updates the Propeller
payment + order. **It never throws** — always return `200` to MultiSafepay so it
doesn't enter a retry loop.

#### Next.js (App Router route handler)

```ts
// app/api/msp/webhook/route.ts
import { NextResponse } from 'next/server';
import { provider } from '@/lib/msp'; // your singleton MspProvider

export async function POST(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get('transactionid') ?? '';
  await provider.handleWebhook(id);     // result is logged internally
  return new NextResponse('OK', { status: 200 }); // always 200
}
```

#### Express

```ts
import express from 'express';
import { provider } from './msp';

const app = express();

app.post('/api/msp/webhook', async (req, res) => {
  await provider.handleWebhook(String(req.query.transactionid ?? ''));
  res.sendStatus(200); // always 200
});
```

#### Optional: verify the signature

MultiSafepay signs notifications with an `Auth` header. Verification is
defence-in-depth (the package always re-fetches to confirm, so it's safe without
it), but you can run it first:

```ts
import { verifyWebhookSignature } from '@propeller-commerce/propeller-v2-msp';

const rawBody = await req.text(); // the EXACT raw body, before JSON.parse
const ok = verifyWebhookSignature(rawBody, req.headers.get('Auth'), MSP_API_KEY);
if (!ok) return new NextResponse('bad signature', { status: 200 }); // still 200
```

### 3. Resolve the outcome on the return page

MultiSafepay redirects the shopper back to your `redirectUrl` **for every
outcome** — completed, initialized, declined all land on the same URL — and the
notification that finalizes the order is asynchronous, so it may not have
arrived yet. Ask MultiSafepay directly with `getPaymentStatus` (keyed by the
order id you stashed):

```ts
const result = await provider.getPaymentStatus(orderId);
// { ok, paymentId, status?, settled?, orderId? }
```

It is **read-only** (never touches Propeller) and always resolves. Use it to
pick the return-page UI and decide the **local cart** action:

| MultiSafepay `status` | `settled` | Return-page UI | Local cart |
|---|---|---|---|
| `completed` / `reserved` / `shipped` | `true` | Success | **clear it** |
| `initialized` / `uncleared` | `false` | "Payment still open" + re-check | **keep it** |
| `declined` / `cancelled` / `void` / `expired` | `false` | Failure + retry | **keep it** |

`settled` is the cart hint: clear the local cart **only** for a captured payment.
An `initialized`/`uncleared` order isn't finalized yet, so keeping the local cart
leaves it in sync with the still-live backend cart; clearing it early would let a
subsequent "add to cart" silently reuse the same un-finalized order. The same
rule is exported as a pure helper:

```ts
import { isSettledStatus } from '@propeller-commerce/propeller-v2-msp';
isSettledStatus('completed');   // true  → clear the local cart
isSettledStatus('initialized'); // false → keep it
isSettledStatus('declined');    // false → keep it
```

> **Two distinct cart rules.** `isSettledStatus` / `getPaymentStatus().settled`
> is the **client / return-page** rule for the shopper's **local** cart. The
> webhook's "clears cart" column below is a **separate, server-side** rule for
> the **backend** cart — it intentionally clears on `initialized`/`uncleared`
> too. Don't conflate them.

## Status mapping (webhook → Propeller)

The webhook classifies the MultiSafepay order and pushes this status tuple to
Propeller:

| MultiSafepay state | txn type | txn status | payment status | order status | clears cart |
|---|---|---|---|---|---|
| completed / reserved / shipped | PAY | SUCCESS | PAID | NEW | ✔ |
| initialized | PAY | OPEN | OPEN | UNFINISHED | ✔ |
| uncleared | PAY | PENDING | PENDING | UNFINISHED | ✔ |
| declined | PAY | FAILED | FAILED | UNFINISHED | ✗ |
| cancelled / void | PAY | FAILED | CANCELLED | UNFINISHED | ✗ |
| expired | PAY | FAILED | EXPIRED | UNFINISHED | ✗ |
| refunded / partial_refunded | REFUND | SUCCESS | PAID | NEW | ✔ |
| chargedback | CHARGEBACK | SUCCESS | CHARGEBACK | NEW | ✔ |

On the "clears cart" rows the package also sends the order confirmation email,
fires the confirm event, and attaches the order PDF — via a single
`orderSetStatus` mutation. Amounts use MultiSafepay's authoritative
(integer-cents) amount.

> The WordPress plugin's `switch` did **not** handle `partial_refunded` or
> `chargedback` (they fell through unhandled). This port handles both explicitly.

This "clears cart" column is the **server-side / backend** cart and is separate
from the **local** cart rule the return page uses (`isSettledStatus` — see
[step 3](#3-resolve-the-outcome-on-the-return-page)), which keeps the local cart
on `initialized`/`uncleared`.

## Public API

| Export | Description |
|---|---|
| `MspProvider` | The provider class — `createPayment`, `handleWebhook`, `getPaymentStatus`. |
| `isSettledStatus` | Pure helper — `true` only for `completed`/`reserved`/`shipped` (the local-cart rule). |
| `verifyWebhookSignature` | Pure helper — HMAC-SHA512 `Auth`-header verification (optional defence-in-depth). |
| `MspProviderConfig`, `MspProviderHost`, `CreatePaymentArgs`, `CreatePaymentResult`, `HandleWebhookResult`, `MspPaymentStatus`, `PaymentStatusResult` | Types. |
| `OrderStatus` | Propeller order-status string consts. |
| `PaymentStatuses`, `TransactionTypes`, `TransactionStatuses` | Re-exported SDK enums. |
| `resolveMspGateway`, `classifyTransaction`, `toCents` | Pure helpers (advanced / testing). |
| `MSP_LIVE_URL`, `MSP_TEST_URL` | The MultiSafepay base URLs. |
| `consoleLogger`, `noopLogger`, `Logger`, `LogLevel` | Logging. |

## Notes & limitations (v1)

- **Refund/chargeback initiation** is out of scope — the package only *reacts*
  to MultiSafepay's refund/chargeback notifications.
- Uses the MultiSafepay **Orders API** (`POST /json/orders`, `GET
  /json/orders/{id}`) in the `redirect` flow.
- **Shopping-cart-required gateways** (Klarna/AfterPay/IN3/Billink/…) need a
  populated `shopping_cart` in the order request, which this `redirect`-flow
  provider does not send. Use the non-BNPL gateways, or extend the client.
- Webhook **idempotency**: MultiSafepay may re-deliver. Payment update by the
  order id is idempotent for status; confirm your backend dedups appended
  transactions if re-delivery matters to you.

## License

MIT
