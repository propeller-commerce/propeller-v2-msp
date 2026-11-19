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
Anyone can call that URL with any `transactionid`, so before anything else
verify the `Auth` signature over the raw body and check that the signed body's
`order_id` is the query's id. Then pass the id to `handleWebhook`; it
re-fetches the order from MultiSafepay (the body is never trusted beyond the
id), classifies it, and updates the Propeller payment + order. **It never
throws** — always return `200` to MultiSafepay so it doesn't enter a retry
loop, also when you ignore a notification.

#### Next.js (App Router route handler)

```ts
// app/api/msp/webhook/route.ts
import { NextResponse } from 'next/server';
import { provider } from '@/lib/msp'; // your singleton MspProvider

export async function POST(req: Request) {
  const ok = () => new NextResponse('OK', { status: 200 }); // always 200
  const rawBody = await req.text(); // the EXACT raw body, before JSON.parse
  if (!provider.verifyWebhookSignature(rawBody, req.headers.get('auth'))) {
    return ok(); // unsigned, forged or stale: ignore
  }
  // The signature covers the body, not the query string: only process the
  // query's id when the signed body names the same order.
  const id = new URL(req.url).searchParams.get('transactionid') ?? '';
  let signedId = '';
  try {
    signedId = String(JSON.parse(rawBody).order_id ?? '');
  } catch {}
  if (!id || signedId !== id) return ok();
  await provider.handleWebhook(id); // result is logged internally
  return ok();
}
```

#### Express

```ts
import express from 'express';
import { provider } from './msp';

const app = express();

// Read the body raw: the signature is over the exact bytes MultiSafepay sent.
app.post('/api/msp/webhook', express.text({ type: () => true }), async (req, res) => {
  const rawBody = typeof req.body === 'string' ? req.body : '';
  const id = String(req.query.transactionid ?? '');
  let signedId = '';
  try {
    signedId = String(JSON.parse(rawBody).order_id ?? '');
  } catch {}
  if (provider.verifyWebhookSignature(rawBody, req.get('Auth')) && id && signedId === id) {
    await provider.handleWebhook(id);
  }
  res.sendStatus(200); // always 200
});
```

#### How the signature check works

MultiSafepay signs each **POST** notification with an `Auth` header (base64 of
`"<timestamp>:<hex HMAC-SHA512>"`, keyed with the MultiSafepay **API key**,
over `"<timestamp>:<raw body>"`). Orders created by this package ask for POST
notifications (`notification_method: 'POST'`).

The signature covers the body, not the query string. Without the `order_id`
comparison in the examples above, a signed notification for one order can be
replayed within the validation window with another order's id in the query
string.

`provider.verifyWebhookSignature(rawBody, authHeader, validationWindowSeconds = 600)`
uses the key the provider runs with (`testApiKey` when `testMode`, else
`liveApiKey`) and rejects signatures whose timestamp is more than the window
in the past or in the future. A window of `0` or less uses the default; the
freshness check can't be switched off. The same check is exported as the pure
function
`verifyWebhookSignature(rawBody, authHeader, apiKey, validationWindowSeconds = 600)`.
Header lookup is case-insensitive in `Headers` (`req.headers.get('auth')`) and
in Express (`req.get('Auth')`). A GET notification has no signature and never
verifies; orders created by an older version of this package (GET
notifications) stop being processed by the webhook once you enforce it.

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
> the **backend** cart. Both keep the cart on `initialized`/`uncleared`, as the
> WordPress plugin does. Don't conflate them.

## Status mapping (webhook → Propeller)

The webhook classifies the MultiSafepay order and pushes this status tuple to
Propeller:

| MultiSafepay state | txn type | txn status | payment status | order status | clears cart |
|---|---|---|---|---|---|
| completed / reserved / shipped | PAY | SUCCESS | PAID | NEW | ✔ |
| initialized | PAY | OPEN | OPEN | UNFINISHED | ✗ |
| uncleared | PAY | PENDING | PENDING | UNFINISHED | ✗ |
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

### The payment must pay the order

Before writing anything, the webhook loads the Propeller order (`id status
currency total { net } paymentData { status }`) and compares it with what
MultiSafepay collected:

- MultiSafepay's amount (integer cents) must equal the order's VAT-inclusive
  total `order.total.net` in whole cents (a total with sub-cent digits, e.g.
  `13.3947`, matches either 1339 or 1340), and the currencies must match.
- On a mismatch, or when the order can't be found, **nothing is written**: the
  Propeller payment and order stay as they are (an unpaid order stays
  `UNFINISHED`, no mail, no PDF, cart kept). The result is `{ ok: false, error }`
  and one log line with the order id and both amounts.
- The confirmation mail, PDF, confirm event and cart deletion run only while
  the order is still `UNFINISHED` and the outcome changes its status or pay
  status, so a re-delivered or replayed notification, or a later refund, does
  not send the confirmation again. `initialized` / `uncleared` never run them
  (as in the WordPress plugin); `completed` / `reserved` / `shipped` run them
  when the order leaves `UNFINISHED`.
- Once the order has left `UNFINISHED`, an `initialized` / `uncleared` /
  `declined` / `cancelled` / `void` / `expired` outcome writes nothing
  (`{ ok: false, error }`): a placed order is never moved back to
  `UNFINISHED`. A `completed` / `reserved` / `shipped` outcome for an order
  whose pay status is already `PAID` is a no-op (`{ ok: true }`, nothing
  written). Refunds and chargebacks still apply: `refunded` /
  `partial_refunded` append a `REFUND` transaction and keep `NEW` / `PAID`,
  `chargedback` appends a `CHARGEBACK` transaction and sets pay status
  `CHARGEBACK`, neither with a second confirmation.

So the host's create-payment route must charge exactly `order.total.net`
(`cart.total.totalNet` before the order exists; **not** `totalGross`, which is
the ex-VAT amount in the SDK's naming). Take it from the order server-side
rather than from the request body.

The order lookup needs the order-editor key (the storefront key gets
`Forbidden resource`). The package adds its lookup's operation name
(`propellerPspOrderTotal`) to the injected client's `orderEditorMutations`
list on the first webhook (when the client has no list, to the SDK defaults
without `passwordResetLink`), so no host change is needed.

This "clears cart" column is the **server-side / backend** cart and is separate
from the **local** cart rule the return page uses (`isSettledStatus` — see
[step 3](#3-resolve-the-outcome-on-the-return-page)), which keeps the local cart
on `initialized`/`uncleared`.

## Public API

| Export | Description |
|---|---|
| `MspProvider` | The provider class — `createPayment`, `handleWebhook`, `getPaymentStatus`, `verifyWebhookSignature(rawBody, authHeader)`. |
| `isSettledStatus` | Pure helper — `true` only for `completed`/`reserved`/`shipped` (the local-cart rule). |
| `verifyWebhookSignature` | Pure helper — HMAC-SHA512 `Auth`-header verification `(rawBody, authHeader, apiKey, windowSeconds = 600)`. |
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
