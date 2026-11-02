import { ChallengeTokenService } from './challenge-token.service';

describe('ChallengeTokenService', () => {
  const originalSecret = process.env.JWT_ACCESS_SECRET;

  beforeAll(() => {
    process.env.JWT_ACCESS_SECRET = 'x'.repeat(32);
  });

  afterAll(() => {
    process.env.JWT_ACCESS_SECRET = originalSecret;
  });

  const service = new ChallengeTokenService();

  describe('MFA-pending tokens', () => {
    it('issues and verifies a token for the right user', () => {
      const token = service.issueMfaPending('user-1');
      expect(service.verifyMfaPending(token)).toEqual({ userId: 'user-1' });
    });

    it('rejects a tampered token', () => {
      const token = service.issueMfaPending('user-1');
      const tampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
      expect(service.verifyMfaPending(tampered)).toBeNull();
    });

    it('rejects an expired token', () => {
      const token = service.issueMfaPending('user-1', -1); // already expired
      expect(service.verifyMfaPending(token)).toBeNull();
    });

    it('does not verify a password-reset token as MFA-pending', () => {
      const resetToken = service.issuePasswordReset('user-1', 'some-hash');
      expect(service.verifyMfaPending(resetToken)).toBeNull();
    });
  });

  describe('user-invite tokens', () => {
    it('issues and verifies a token bound to the placeholder password hash', () => {
      const token = service.issueUserInvite('user-1', 'placeholder-hash');
      expect(service.verifyUserInvite(token, 'placeholder-hash')).toEqual({ userId: 'user-1' });
    });

    it('invalidates the token once the password is set (accept-invite replaces the hash)', () => {
      const token = service.issueUserInvite('user-1', 'placeholder-hash');
      expect(service.verifyUserInvite(token, 'real-password-hash')).toBeNull();
    });

    it('rejects an expired invite token', () => {
      const token = service.issueUserInvite('user-1', 'placeholder-hash', -1);
      expect(service.verifyUserInvite(token, 'placeholder-hash')).toBeNull();
    });

    it('does not verify an MFA-pending token as a user invite', () => {
      const mfaToken = service.issueMfaPending('user-1');
      expect(service.verifyUserInvite(mfaToken, 'placeholder-hash')).toBeNull();
    });
  });

  describe('password-reset tokens', () => {
    it('issues and verifies a token bound to the current password hash', () => {
      const token = service.issuePasswordReset('user-1', 'hash-v1');
      expect(service.verifyPasswordReset(token, 'hash-v1')).toEqual({ userId: 'user-1' });
    });

    it('invalidates the token once the password hash changes (single-use semantics)', () => {
      const token = service.issuePasswordReset('user-1', 'hash-v1');
      expect(service.verifyPasswordReset(token, 'hash-v2')).toBeNull();
    });

    it('rejects an expired reset token', () => {
      const token = service.issuePasswordReset('user-1', 'hash-v1', -1);
      expect(service.verifyPasswordReset(token, 'hash-v1')).toBeNull();
    });
  });
});
