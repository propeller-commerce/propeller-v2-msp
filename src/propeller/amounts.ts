/**
 * Amount conversion.
 *
 * Both **MultiSafepay** and **Propeller** represent amounts as an integer
 * number of **cents** (minor units), e.g. `1000` for ten euros. So — unlike the
 * Mollie provider, which had to format a `"10.00"` decimal string for Mollie —
 * there is a single conversion here: major units → integer cents.
 *
 * The WordPress plugin did `(int) round(floatval($value) * 100)`. Naive
 * `value * 100` in JS hits floating-point error (`1.1 * 100 === 110.00000000000001`),
 * so we round explicitly. `Math.round` is correct here for the cent precision we
 * need across realistic order totals.
 */

/**
 * Convert a major-unit amount (number or decimal string, e.g. `10` / `"9.90"`)
 * to an integer number of cents for both the MultiSafepay `amount` field and
 * Propeller inputs.
 *
 * @throws if the value is not a finite, non-negative number.
 */
export function toCents(value: string | number): number {
  const major = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(major) || major < 0) {
    throw new Error(`Invalid amount for cents conversion: ${JSON.stringify(value)}`);
  }
  // Round at the cent boundary to absorb binary-float drift.
  return Math.round(major * 100);
}

/**
 * Whether a PSP amount pays a Propeller order total.
 *
 * `paidCents` is what the PSP actually collected (integer cents). `orderTotal`
 * is the order's `total.net` (VAT-inclusive, major units). Propeller keeps up
 * to four decimals (e.g. `13.3947`) and a PSP can only charge whole cents, so a
 * total with sub-cent digits is paid by either neighbouring cent (the host may
 * round either way); a whole-cent total must match exactly. Compared in integer
 * hundredths of a cent so float drift can't widen the window.
 */
export function matchesOrderTotal(
  paidCents: number,
  paidCurrency: string,
  orderTotal: number,
  orderCurrency: string
): boolean {
  if (!Number.isInteger(paidCents) || !Number.isFinite(orderTotal)) return false;
  if (!paidCurrency || paidCurrency.trim().toUpperCase() !== (orderCurrency || '').trim().toUpperCase()) {
    return false;
  }
  return Math.abs(paidCents * 100 - Math.round(orderTotal * 10000)) < 100;
}
