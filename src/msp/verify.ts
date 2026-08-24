/**
 * MultiSafepay webhook signature verification.
 *
 * MultiSafepay signs POST webhooks with an `Auth` header: base64 of
 * `"{timestamp}:{sha512hex}"`, where `sha512hex` is
 * `HMAC-SHA512(key = trim(apiKey), message = "{timestamp}:{rawBody}")` as
 * lowercase hex. A freshness window (default 600s) rejects replays.
 *
 * Faithful port of the SDK's `Util/Notification::verifyNotification`. The
 * WordPress plugin does NOT call it (it re-fetches the order to confirm state),
 * and this package does the same fetch-to-confirm — so verification is an
 * OPTIONAL defence-in-depth check the host can run before `handleWebhook`. Since
 * we never trust the webhook body beyond the id and always re-fetch, skipping it
 * is safe; running it is strictly better.
 *
 * Pure + dependency-free (Node `crypto`), so it's trivially unit-testable.
 */

import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Verify a MultiSafepay webhook signature.
 *
 * @param rawBody The exact raw POST body string (verify BEFORE JSON.parse — a
 *   re-serialized body will not match the signature).
 * @param authHeader The value of the inbound `Auth` header.
 * @param apiKey The MultiSafepay API key (same one used for API calls).
 * @param validationWindowSeconds Reject if the signed timestamp is older than
 *   this many seconds (default 600). Pass 0 to disable the freshness check.
 * @returns true only if the signature is present, fresh, and matches.
 */
export function verifyWebhookSignature(
  rawBody: string,
  authHeader: string | null | undefined,
  apiKey: string,
  validationWindowSeconds = 600
): boolean {
  if (!authHeader || !apiKey) return false;

  let decoded: string;
  try {
    decoded = Buffer.from(authHeader, 'base64').toString('utf8');
  } catch {
    return false;
  }

  const sep = decoded.indexOf(':');
  if (sep < 0) return false;
  const timestamp = decoded.slice(0, sep);
  const providedHex = decoded.slice(sep + 1);
  if (!timestamp || !providedHex) return false;

  if (validationWindowSeconds > 0) {
    const ts = Number(timestamp);
    // `Date.now()` is unavailable in some sandboxes but this runs at request
    // time in a real host; guard against a non-finite timestamp.
    if (!Number.isFinite(ts)) return false;
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (ts + validationWindowSeconds < nowSeconds) return false;
  }

  const expectedHex = createHmac('sha512', apiKey.trim())
    .update(`${timestamp}:${rawBody}`)
    .digest('hex');

  // Constant-time compare. Lengths must match for timingSafeEqual.
  const a = Buffer.from(providedHex, 'utf8');
  const b = Buffer.from(expectedHex, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
