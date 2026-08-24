import { isSettledStatus } from '../src/MspProvider';

describe('isSettledStatus — the local/return-page cart rule', () => {
  it('is true only for captured states (clear the local cart)', () => {
    expect(isSettledStatus('completed')).toBe(true);
    expect(isSettledStatus('reserved')).toBe(true);
    expect(isSettledStatus('shipped')).toBe(true);
  });

  it('is false for not-yet-resolved states (keep the cart in sync with backend)', () => {
    expect(isSettledStatus('initialized')).toBe(false);
    expect(isSettledStatus('uncleared')).toBe(false);
  });

  it('is false for failure states (keep the cart for retry)', () => {
    expect(isSettledStatus('declined')).toBe(false);
    expect(isSettledStatus('cancelled')).toBe(false);
    expect(isSettledStatus('void')).toBe(false);
    expect(isSettledStatus('expired')).toBe(false);
  });

  it('is case-insensitive and safe on empty/garbage input', () => {
    expect(isSettledStatus('COMPLETED')).toBe(true);
    expect(isSettledStatus('')).toBe(false);
    expect(isSettledStatus('nonsense')).toBe(false);
  });
});
