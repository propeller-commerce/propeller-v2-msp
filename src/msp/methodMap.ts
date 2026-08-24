/**
 * Map a Propeller payment-method code to a MultiSafepay gateway code.
 *
 * MultiSafepay gateway codes are UPPERCASE identifiers sent in the order
 * request's `gateway` field (e.g. `'IDEAL'`, `'VISA'`, `'BANKTRANS'`). The full
 * catalog is dynamic (fetched from `GET /json/gateways`), so we do NOT hardcode
 * it — we only map the common Propeller method codes to their gateway code.
 *
 * Unlike the Mollie plugin (which defaulted unknown codes to `creditcard`), an
 * unknown/empty code here resolves to `undefined`. Passing no `gateway` to
 * MultiSafepay makes it show its own hosted method-selection page — a sensible
 * default for a redirect flow, and the safest behaviour for a gateway catalog
 * we don't fully enumerate.
 */

const METHOD_MAP: Record<string, string> = {
  ideal: 'IDEAL',
  multisafepay_ideal: 'IDEAL',
  creditcard: 'CREDITCARD',
  card: 'CREDITCARD',
  visa: 'VISA',
  mastercard: 'MASTERCARD',
  maestro: 'MAESTRO',
  amex: 'AMEX',
  bancontact: 'MISTERCASH',
  mistercash: 'MISTERCASH',
  banktransfer: 'BANKTRANS',
  banktrans: 'BANKTRANS',
  directdebit: 'DIRDEB',
  dirdeb: 'DIRDEB',
  paypal: 'PAYPAL',
  belfius: 'BELFIUS',
  kbc: 'KBC',
  eps: 'EPS',
  giropay: 'GIROPAY',
  sofort: 'DIRECTBANK',
  directbank: 'DIRECTBANK',
  przelewy24: 'P24',
  p24: 'P24',
  mybank: 'MYBANK',
  paysafecard: 'PSAFECARD',
  applepay: 'APPLEPAY',
  googlepay: 'GOOGLEPAY',
  klarna: 'KLARNA',
  in3: 'IN3',
  billink: 'BILLINK',
  trustly: 'TRUSTLY',
  giftcard: 'GIFTCARD',
};

/**
 * Resolve a Propeller method code to a MultiSafepay gateway code.
 * Unknown/empty codes return `undefined` → let MultiSafepay show its own
 * hosted method-selection page (the `gateway` field is omitted from the order).
 */
export function resolveMspGateway(propellerMethod: string | undefined | null): string | undefined {
  const key = (propellerMethod ?? '').toLowerCase().trim();
  if (!key) return undefined;
  return METHOD_MAP[key];
}
