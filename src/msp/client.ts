/**
 * Thin `fetch` seam over the MultiSafepay JSON API.
 *
 * MultiSafepay has no official Node SDK we want to depend on, and its API is a
 * plain JSON REST surface — so this is a ~zero-dependency client built on the
 * global `fetch` (Node 18+). That also means the Mollie provider's CJS→ESM
 * interop gotcha simply doesn't exist here: there is no third-party client to
 * default-vs-named import.
 *
 * Responsibilities:
 *  - select the base URL (test vs live) from `testMode`;
 *  - authenticate every request with the `api_key` header;
 *  - create an order (`POST /json/orders`, type `redirect`) and surface its
 *    payment URL;
 *  - fetch an order (`GET /json/orders/{orderId}`) and reduce it to the
 *    version-stable snapshot the status ladder consumes.
 *
 * The MultiSafepay envelope is `{ success, data, error_code, error_info }`; a
 * non-`success` body (or a non-2xx HTTP status) throws.
 */

import type { MspProviderConfig } from '../types';
import type { MspTransactionSnapshot } from './statusLadder';
import { verifyWebhookSignature } from './verify';

/** MultiSafepay API base URLs. */
export const MSP_LIVE_URL = 'https://api.multisafepay.com/v1/';
export const MSP_TEST_URL = 'https://testapi.multisafepay.com/v1/';

/** Parameters for creating a MultiSafepay order (redirect flow). */
export interface MspOrderCreateParams {
  /** Propeller order id — sent as MultiSafepay's `order_id` (echoed back in the webhook/status). */
  orderId: number;
  /** Integer amount in minor units (cents). */
  amount: number;
  /** ISO 4217 currency, e.g. "EUR". */
  currency: string;
  description: string;
  redirectUrl: string;
  cancelUrl: string;
  notificationUrl: string;
  /** Resolved MultiSafepay gateway code (e.g. "IDEAL"); omitted → MSP shows its own selector. */
  gateway?: string;
  /** Optional user id, stashed in `var1` (plugin parity). */
  userId?: number;
}

/** What we extract from a freshly created MultiSafepay order. */
export interface MspOrderCreated {
  /** MultiSafepay's `order_id` echo (equals the Propeller order id we sent). */
  orderId: string;
  /** Hosted checkout URL — redirect the shopper here. */
  paymentUrl: string | null;
}

/** MultiSafepay response envelope. */
interface MspEnvelope<T> {
  success: boolean;
  data?: T;
  error_code?: number;
  error_info?: string;
}

/** The transaction/order shape we read fields off (subset). */
interface MspOrderData {
  order_id?: string | number;
  status?: string;
  amount?: number;
  currency?: string;
  payment_url?: string;
  transaction_id?: string | number;
  var1?: string | number;
}

/** Resolve the active base URL from `testMode`. */
export function resolveBaseUrl(config: MspProviderConfig): string {
  return config.testMode ? MSP_TEST_URL : MSP_LIVE_URL;
}

/**
 * A small wrapper holding the resolved base URL + api key. Exposes the two
 * operations the provider needs.
 */
export class MspGateway {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly locale: string;

  constructor(config: MspProviderConfig) {
    this.apiKey = config.testMode ? config.testApiKey : config.liveApiKey;
    if (!this.apiKey) {
      throw new Error(
        `MultiSafepay API key missing: ${config.testMode ? 'testApiKey' : 'liveApiKey'} is empty (testMode=${config.testMode}).`
      );
    }
    this.baseUrl = resolveBaseUrl(config);
    this.locale = config.locale ?? 'en_US';
  }

  /** Build a full URL for an endpoint, appending the locale query param. */
  private url(endpoint: string): string {
    const sep = endpoint.includes('?') ? '&' : '?';
    return `${this.baseUrl}${endpoint}${sep}locale=${encodeURIComponent(this.locale)}`;
  }

  /** Issue a request and unwrap the MultiSafepay envelope, throwing on failure. */
  private async request<T>(
    endpoint: string,
    method: 'GET' | 'POST',
    body?: unknown
  ): Promise<T> {
    const res = await fetch(this.url(endpoint), {
      method,
      headers: {
        api_key: this.apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    let envelope: MspEnvelope<T>;
    try {
      envelope = (await res.json()) as MspEnvelope<T>;
    } catch {
      throw new Error(
        `MultiSafepay ${method} ${endpoint} returned non-JSON (HTTP ${res.status}).`
      );
    }

    if (!res.ok || !envelope.success) {
      const code = envelope.error_code ?? res.status;
      const info = envelope.error_info ?? res.statusText;
      throw new Error(`MultiSafepay ${method} ${endpoint} failed: ${code} ${info}`);
    }
    if (envelope.data === undefined) {
      throw new Error(`MultiSafepay ${method} ${endpoint} succeeded but returned no data.`);
    }
    return envelope.data;
  }

  /** Verify a POST notification's `Auth` header with the active API key. */
  verifySignature(
    rawBody: string,
    authHeader: string | null | undefined,
    validationWindowSeconds?: number
  ): boolean {
    return verifyWebhookSignature(rawBody, authHeader, this.apiKey, validationWindowSeconds);
  }

  /** Create a MultiSafepay redirect order and return its id + payment URL. */
  async createOrder(params: MspOrderCreateParams): Promise<MspOrderCreated> {
    const body: Record<string, unknown> = {
      type: 'redirect',
      order_id: params.orderId,
      currency: params.currency,
      amount: params.amount, // integer cents
      description: params.description,
      payment_options: {
        notification_url: params.notificationUrl,
        // POST notifications carry the signed `Auth` header; GET ones are
        // unsigned. The id stays in the query string (`?transactionid=`).
        notification_method: 'POST',
        redirect_url: params.redirectUrl,
        cancel_url: params.cancelUrl,
        close_window: true,
      },
      ...(params.gateway ? { gateway: params.gateway } : {}),
      ...(params.userId !== undefined ? { var1: String(params.userId) } : {}),
    };

    const data = await this.request<MspOrderData>('json/orders', 'POST', body);

    return {
      orderId: data.order_id != null ? String(data.order_id) : String(params.orderId),
      paymentUrl: data.payment_url ?? null,
    };
  }

  /**
   * Fetch an order by id and reduce it to the snapshot the status ladder uses,
   * plus the fields the Propeller update needs (authoritative amount, currency,
   * and the natively-returned order id).
   *
   * MultiSafepay amounts are integer cents, so `amount` is returned as cents;
   * the caller converts as needed.
   */
  async getOrderSnapshot(orderId: string): Promise<{
    snapshot: MspTransactionSnapshot;
    amountCents: number | undefined;
    currency: string | undefined;
    orderId: number | undefined;
  }> {
    const data = await this.request<MspOrderData>(
      `json/orders/${encodeURIComponent(orderId)}`,
      'GET'
    );

    const rawOrderId = data.order_id;
    const parsedOrderId =
      typeof rawOrderId === 'number'
        ? rawOrderId
        : rawOrderId != null && !Number.isNaN(Number(rawOrderId))
        ? Number(rawOrderId)
        : undefined;

    return {
      snapshot: { status: data.status ?? '' },
      amountCents: typeof data.amount === 'number' ? data.amount : undefined,
      currency: data.currency,
      orderId: parsedOrderId,
    };
  }
}
