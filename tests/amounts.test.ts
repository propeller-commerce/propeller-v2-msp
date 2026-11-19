import { toCents, matchesOrderTotal } from '../src/propeller/amounts';

describe('toCents', () => {
  it('converts whole major units to cents', () => {
    expect(toCents(10)).toBe(1000);
    expect(toCents(0)).toBe(0);
  });

  it('converts decimal-string amounts to cents', () => {
    expect(toCents('9.90')).toBe(990);
    expect(toCents('10.00')).toBe(1000);
    expect(toCents('0.01')).toBe(1);
  });

  it('absorbs binary-float drift (1.1 * 100)', () => {
    expect(toCents(1.1)).toBe(110); // naive 1.1 * 100 === 110.00000000000001
    expect(toCents(49.95)).toBe(4995);
  });

  it('throws on negative or non-finite input', () => {
    expect(() => toCents(-1)).toThrow();
    expect(() => toCents('abc')).toThrow();
    expect(() => toCents(Infinity)).toThrow();
  });
});

describe('matchesOrderTotal', () => {
  it('whole-cent totals must match exactly; sub-cent totals match either neighbouring cent', () => {
    expect(matchesOrderTotal(1107, 'EUR', 11.07, 'EUR')).toBe(true);
    expect(matchesOrderTotal(1108, 'EUR', 11.07, 'EUR')).toBe(false);
    expect(matchesOrderTotal(1339, 'EUR', 13.3947, 'EUR')).toBe(true);
    expect(matchesOrderTotal(1340, 'EUR', 13.3947, 'EUR')).toBe(true);
    expect(matchesOrderTotal(1338, 'EUR', 13.3947, 'EUR')).toBe(false);
  });

  it('rejects the ex-VAT total, another currency and non-integer cents', () => {
    expect(matchesOrderTotal(1107, 'EUR', 13.3947, 'EUR')).toBe(false);
    expect(matchesOrderTotal(1107, 'USD', 11.07, 'EUR')).toBe(false);
    expect(matchesOrderTotal(1107.5, 'EUR', 11.075, 'EUR')).toBe(false);
  });
});
