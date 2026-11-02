import { authenticator } from 'otplib';
import { TotpService } from './totp.service';

describe('TotpService', () => {
  const originalKey = process.env.MFA_ENCRYPTION_KEY;

  beforeAll(() => {
    process.env.MFA_ENCRYPTION_KEY = 'a'.repeat(32);
  });

  afterAll(() => {
    process.env.MFA_ENCRYPTION_KEY = originalKey;
  });

  const service = new TotpService();

  it('generates a secret and verifies a code produced from it', () => {
    const secret = service.generateSecret();
    const code = authenticator.generate(secret);
    expect(service.verify(secret, code)).toBe(true);
  });

  it('rejects an incorrect code', () => {
    const secret = service.generateSecret();
    expect(service.verify(secret, '000000')).toBe(false);
  });

  it('rejects a code generated from a different secret', () => {
    const secretA = service.generateSecret();
    const secretB = service.generateSecret();
    const codeForB = authenticator.generate(secretB);
    expect(service.verify(secretA, codeForB)).toBe(false);
  });

  it('round-trips encrypt/decrypt of a secret', () => {
    const secret = service.generateSecret();
    const encrypted = service.encryptSecret(secret);
    expect(encrypted).not.toEqual(secret);
    expect(service.decryptSecret(encrypted)).toEqual(secret);
  });

  it('produces a keyUri containing the account email and issuer', () => {
    const secret = service.generateSecret();
    const uri = service.keyUri(secret, 'maker@acme.test');
    expect(uri).toContain('otpauth://totp/');
    expect(uri).toContain(encodeURIComponent('maker@acme.test'));
  });

  it('throws if MFA_ENCRYPTION_KEY is missing when encrypting', () => {
    delete process.env.MFA_ENCRYPTION_KEY;
    expect(() => service.encryptSecret('somesecret')).toThrow();
    process.env.MFA_ENCRYPTION_KEY = 'a'.repeat(32);
  });
});
