import { createHmac } from 'crypto';
import { verifyWebhookSignature } from '../src/msp/verify';

const API_KEY = 'test_secret_key_123';

/** Build a valid `Auth` header for a body at a given unix timestamp. */
function makeAuth(rawBody: string, timestamp: number, key = API_KEY): string {
  const hex = createHmac('sha512', key.trim())
    .update(`${timestamp}:${rawBody}`)
    .digest('hex');
  return Buffer.from(`${timestamp}:${hex}`, 'utf8').toString('base64');
}

describe('verifyWebhookSignature', () => {
  const body = '{"order_id":123,"status":"completed"}';
  const now = Math.floor(Date.now() / 1000);

  it('accepts a fresh, correctly-signed notification', () => {
    const auth = makeAuth(body, now);
    expect(verifyWebhookSignature(body, auth, API_KEY)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const auth = makeAuth(body, now);
    expect(verifyWebhookSignature(body + ' ', auth, API_KEY)).toBe(false);
  });

  it('rejects a wrong key', () => {
    const auth = makeAuth(body, now, 'other_key');
    expect(verifyWebhookSignature(body, auth, API_KEY)).toBe(false);
  });

  it('rejects a stale timestamp (older than the window)', () => {
    const auth = makeAuth(body, now - 601);
    expect(verifyWebhookSignature(body, auth, API_KEY, 600)).toBe(false);
  });

  it('rejects a timestamp more than the window in the future', () => {
    expect(verifyWebhookSignature(body, makeAuth(body, now + 601), API_KEY, 600)).toBe(false);
    expect(verifyWebhookSignature(body, makeAuth(body, now + 100000), API_KEY)).toBe(false);
  });

  it('accepts a timestamp slightly in the future (clock skew inside the window)', () => {
    expect(verifyWebhookSignature(body, makeAuth(body, now + 30), API_KEY, 600)).toBe(true);
  });

  it.each([0, -1, NaN, Infinity, -Infinity])(
    'a window of %p does not disable the freshness check: the 600s default applies',
    (window) => {
      expect(verifyWebhookSignature(body, makeAuth(body, now - 100000), API_KEY, window)).toBe(false);
      expect(verifyWebhookSignature(body, makeAuth(body, now + 100000), API_KEY, window)).toBe(false);
      expect(verifyWebhookSignature(body, makeAuth(body, now - 300), API_KEY, window)).toBe(true);
    }
  );

  it('rejects missing / malformed headers and empty key', () => {
    const auth = makeAuth(body, now);
    expect(verifyWebhookSignature(body, null, API_KEY)).toBe(false);
    expect(verifyWebhookSignature(body, undefined, API_KEY)).toBe(false);
    expect(verifyWebhookSignature(body, '', API_KEY)).toBe(false);
    expect(verifyWebhookSignature(body, Buffer.from('no-colon', 'utf8').toString('base64'), API_KEY)).toBe(false);
    expect(verifyWebhookSignature(body, auth, '')).toBe(false);
  });
});
