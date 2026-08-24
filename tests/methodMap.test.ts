import { resolveMspGateway } from '../src/msp/methodMap';

describe('resolveMspGateway', () => {
  it('maps known Propeller codes to MultiSafepay gateway codes', () => {
    expect(resolveMspGateway('ideal')).toBe('IDEAL');
    expect(resolveMspGateway('creditcard')).toBe('CREDITCARD');
    expect(resolveMspGateway('paypal')).toBe('PAYPAL');
    expect(resolveMspGateway('bancontact')).toBe('MISTERCASH');
    expect(resolveMspGateway('banktransfer')).toBe('BANKTRANS');
  });

  it('is case- and whitespace-insensitive', () => {
    expect(resolveMspGateway('  IDEAL ')).toBe('IDEAL');
    expect(resolveMspGateway('PayPal')).toBe('PAYPAL');
  });

  it('returns undefined for unknown or empty codes (→ MSP shows its own selector)', () => {
    expect(resolveMspGateway('not-a-real-method')).toBeUndefined();
    expect(resolveMspGateway('')).toBeUndefined();
    expect(resolveMspGateway(undefined)).toBeUndefined();
    expect(resolveMspGateway(null)).toBeUndefined();
  });
});
