# Changelog

All notable changes to `@propeller-commerce/propeller-v2-msp` are documented
here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
once it reaches 1.0. Until then (the `0.x` line) the public API may change
between minor versions.

## [0.1.4] - 2026-11-19

### Security

- **`handleWebhook` only acts on a transaction that pays the order** (security
  review #19). It loads the Propeller order (`status`, `currency`,
  `total.net`) and writes nothing (no payment update, no `orderSetStatus`, no
  mail / PDF / `deleteCart`) unless MultiSafepay's amount equals the order's
  VAT-inclusive total in whole cents and the currencies match. Before, a
  one-cent transaction created against any order id set that order to
  `NEW` / `PAID` with the confirmation mail, and an `initialized` /
  `uncleared` one cleared its cart. Mismatches and unknown orders return
  `{ ok: false, error }` and log the order id and both amounts.
- The confirmation mail, PDF, confirm event and `deleteCart` now run only while
  the order is still `UNFINISHED` and the outcome changes its status or pay
  status, so a replayed notification (the webhook URL accepts any
  `transactionid`) or a later refund no longer sends the confirmation again.
- **`initialized` / `uncleared` no longer fulfil.** They keep the order
  `UNFINISHED`, so before, every delivery of either status (also an unsigned
  GET with a guessed order id) re-sent the confirmation mail, PDF and confirm
  event and cleared the backend cart. They now only update the payment and pay
  status, as the WordPress plugin's `webhook.php` does; `completed` /
  `reserved` / `shipped` fulfil when they arrive. The backend cart is now kept
  until the payment completes.
- **A non-paying outcome no longer downgrades a placed order.** Once the
  Propeller order has left `UNFINISHED`, an `initialized` / `uncleared` /
  `declined` / `cancelled` / `void` / `expired` transaction writes nothing and
  returns
  `{ ok: false, error: 'order is already <status>; <status> transaction ignored' }`.
  Before, such a transaction for the order's total set the order back to
  `UNFINISHED` with pay status `CANCELLED` / `EXPIRED` / …. A `completed` /
  `reserved` / `shipped` notification for an order whose pay status is already
  `PAID` is now a no-op (`ok: true`, nothing written). Refunds and chargebacks
  are unchanged: `refunded` / `partial_refunded` append a `REFUND` transaction
  and keep the order `NEW` / `PAID`; `chargedback` appends a `CHARGEBACK`
  transaction and sets the pay status to `CHARGEBACK`; neither re-sends the
  confirmation. The order lookup now also selects `paymentData { status }`.
- **The order-lookup fallback no longer elevates `passwordResetLink`.** For a
  host client without its own `orderEditorMutations`, the package wrote a copy
  of the old SDK default list onto it, `passwordResetLink` included, so that
  mutation (which returns the reset link) went out with the order-editor key.
  The fallback is now `orderSetStatus`, `triggerQuoteSendRequest`,
  `triggerOrderSendConfirm` plus the lookup's own operation, matching the SDK's
  new default. A host that lists `passwordResetLink` itself keeps its list.
- **`verifyWebhookSignature` rejects timestamps from the future and can't be
  switched off.** It only rejected a signed timestamp older than the window, so
  a signature made with a far-future timestamp stayed valid indefinitely, and a
  window of `0` (or any value `<= 0`) disabled the freshness check. A
  timestamp more than the window ahead of the clock is now rejected too, and a
  window that isn't a positive finite number falls back to the 600 s default.
- **README webhook examples verify first.** The Next.js and Express examples
  called `handleWebhook` with the query's `transactionid` and no checks. They
  now verify the `Auth` signature over the raw body and require the signed
  body's `order_id` to equal the query's id before calling `handleWebhook`.

### Added

- `MspProvider#verifyWebhookSignature(rawBody, authHeader, validationWindowSeconds = 600)`:
  checks the notification's `Auth` header with the API key the provider runs
  with (test or live per `testMode`). Hosts should call it before
  `handleWebhook`; see the README.

### Changed

- Orders are created with `payment_options.notification_method: 'POST'`, so
  notifications carry the signed `Auth` header (GET notifications are
  unsigned). The transaction id stays in the query string, so webhook routes
  that read `?transactionid=` keep working.
- The order lookup runs under the order-editor key: on the first webhook the
  package adds its operation name `propellerPspOrderTotal` to the injected
  client's `orderEditorMutations` (falling back to the SDK defaults, minus
  `passwordResetLink`, when the host set none). No host change needed. Hosts
  must charge `order.total.net` (incl. VAT); a payment of the ex-VAT total
  (`totalGross`) is now refused.

## [0.1.3] - 2026-09-23

### Changed

- Releases now publish from GitHub Actions using npm trusted publishing (OIDC)
  instead of a long-lived npm token in GitLab CI. No package code changed; this
  version exists to exercise the new path end to end.

  npm only accepts github.com, gitlab.com and CircleCI as OIDC issuers, and our
  GitLab is self-hosted, so it cannot mint a token npm will accept. Meanwhile
  2FA-bypass tokens — the only thing that made non-interactive publishing work —
  lose the ability to publish directly around January 2027. Publishing therefore
  moves to the public mirror, where the runner mints a short-lived token scoped
  to that repository and workflow, and no publish credential is stored anywhere.

  Tarballs from this version on carry npm provenance attestation.

## [0.1.2] - 2026-07-22

### Changed

- Widen the `@propeller-commerce/propeller-sdk-v2` peer range from `^0.12.0` to
  `*`. The strict caret pinned consumers to SDK 0.12.x, so bumping an app to SDK
  0.13.0 produced an `ERESOLVE` peer conflict. `*` matches the SDK peer the UI
  packages already declare and stops this package from blocking SDK minor bumps.

## [0.1.1] - 2026-07-08

### Changed

- Bumped the `@propeller-commerce/propeller-sdk-v2` peer/dev dependency to
  `^0.12.0`. No API change — tracks the SDK's 0.12.0 release.

## [0.1.0] - 2026-07-03

Initial scaffold — a TypeScript port of the Propeller WordPress MultiSafepay
plugin as a standalone, framework-agnostic, server-side package. Mirrors the
architecture of `@propeller-commerce/propeller-v2-mollie`.

### Added

- **`MspProvider`** with three operations:
  - `createPayment(args)` — creates a MultiSafepay redirect order
    (`POST /json/orders`) + a Propeller payment (status `OPEN` with an
    `AUTHORIZATION` transaction) and returns the MultiSafepay checkout URL.
  - `handleWebhook(transactionId)` — re-fetches the order from MultiSafepay
    (`GET /json/orders/{id}`), classifies it, and updates the Propeller payment
    + order. Never throws (the host always returns 200).
  - `getPaymentStatus(orderId)` — read-only live status lookup for the return
    page. Returns the canonical status, a `settled` cart hint, and the order id.
- **PSP inputs**: `{ liveApiKey, testApiKey, testMode, locale? }`. `testMode`
  selects both the key **and** the base URL (MultiSafepay has separate live/test
  hosts, `api` / `testapi.multisafepay.com`).
- **Host wiring** via an injected SDK `GraphQLClient` (no Propeller credentials
  held here) + `webhookUrl` + optional `logger`.
- **Zero PSP runtime dependencies** — a `fetch`-based MultiSafepay gateway
  (`msp/client.ts`) against the JSON API, `api_key`-header auth, live/test base
  URL from `testMode`. No third-party client, so none of the Mollie provider's
  CJS→ESM interop class of bug applies.
- **Webhook status ladder** (`classifyTransaction`) — port of the plugin's
  status switch, **correcting** the plugin's omission of `partial_refunded` /
  `chargedback` (both now handled) and mapping the full MultiSafepay status set
  (`completed`/`initialized`/`uncleared`/`reserved`/`declined`/`cancelled`/
  `void`/`expired`/`refunded`/`partial_refunded`/`chargedback`/`shipped`).
- **`isSettledStatus`** local/return-page cart rule — true only for
  `completed`/`reserved`/`shipped`.
- **`verifyWebhookSignature`** — HMAC-SHA512 `Auth`-header verification (a port
  of the SDK's `Util/Notification`), exported as an optional defence-in-depth
  check for hosts.
- **Propeller seams** over the SDK service factories: `paymentService`
  (create/update with inline `addTransaction`, provider `'MultiSafepay'`) and
  `orderService.setOrderStatus` (one mutation consolidating status, payStatus,
  PDF, confirmation email, event, and cart deletion).
- Gateway-code mapping (`resolveMspGateway`, Propeller code → UPPERCASE MSP
  gateway; unknown → MSP's own selector) and the `toCents` amount helper
  (MultiSafepay amounts are integer cents — no decimal-string formatting needed,
  unlike Mollie).
- Dual CJS + ESM build, `.d.ts` types, unit tests (status ladder, amounts,
  gateway map, settled-status, signature verification).

### Known follow-ups

- Validate that the single `orderSetStatus` reproduces the plugin's two-step
  `change_status` + `triggerOrderSendConfirm` against the live backend.
- Shopping-cart-required gateways (Klarna/AfterPay/IN3/…) need a `shopping_cart`
  in the order request — not sent by this `redirect`-flow provider.
- Webhook idempotency on re-delivery (transaction dedup).
- Integration tests for `createPayment` / `handleWebhook` with a mocked
  MultiSafepay `fetch` + SDK client.
