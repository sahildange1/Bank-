import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';

interface ChallengePayload {
  purpose: 'MFA_PENDING' | 'PASSWORD_RESET' | 'USER_INVITE';
  userId: string;
  /**
   * For PASSWORD_RESET: a fingerprint of the user's current passwordHash at
   * issuance time. Verification re-checks this against the live value, so a
   * token becomes invalid the moment the password changes — giving
   * single-use behaviour without a dedicated token table. For MFA_PENDING
   * this is omitted (issuance is tied to a fresh login, not a stored secret).
   */
  bindingFingerprint?: string;
  expiresAt: number; // epoch ms
}

/**
 * HMAC-SHA256 signed, base64url-encoded tokens — standard library primitives
 * (`node:crypto`), not a custom algorithm. Used for short-lived,
 * server-stateless challenges (MFA-pending after password check, and
 * password-reset links) so we don't need a dedicated database table and
 * cleanup job for something that expires in minutes anyway.
 */
@Injectable()
export class ChallengeTokenService {
  private getSecret(): string {
    const secret = process.env.JWT_ACCESS_SECRET;
    if (!secret || secret.length < 32) {
      throw new Error('JWT_ACCESS_SECRET must be set and at least 32 chars (reused here as the HMAC key)');
    }
    return secret;
  }

  private sign(payload: ChallengePayload): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto.createHmac('sha256', this.getSecret()).update(body).digest('base64url');
    return `${body}.${signature}`;
  }

  private verifyAndDecode(token: string): ChallengePayload | null {
    const [body, signature] = token.split('.');
    if (!body || !signature) return null;

    const expectedSignature = crypto.createHmac('sha256', this.getSecret()).update(body).digest('base64url');
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expectedSignature);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return null;
    }

    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ChallengePayload;
      if (payload.expiresAt < Date.now()) return null;
      return payload;
    } catch {
      return null;
    }
  }

  issueMfaPending(userId: string, ttlMs = 5 * 60 * 1000): string {
    return this.sign({ purpose: 'MFA_PENDING', userId, expiresAt: Date.now() + ttlMs });
  }

  verifyMfaPending(token: string): { userId: string } | null {
    const payload = this.verifyAndDecode(token);
    if (!payload || payload.purpose !== 'MFA_PENDING') return null;
    return { userId: payload.userId };
  }

  /**
   * Invite tokens are bound to the invited user's passwordHash at issuance,
   * same single-use-without-a-table trick as password reset: the invited
   * row starts with an unusable random placeholder hash (see
   * UsersService.inviteUser), and accepting the invite replaces it — which
   * invalidates the token the moment it's used, and invalidates any
   * re-sent older invite the moment a newer one is issued and accepted.
   */
  issueUserInvite(userId: string, placeholderPasswordHash: string, ttlMs = 7 * 24 * 60 * 60 * 1000): string {
    const bindingFingerprint = crypto.createHash('sha256').update(placeholderPasswordHash).digest('base64url');
    return this.sign({ purpose: 'USER_INVITE', userId, bindingFingerprint, expiresAt: Date.now() + ttlMs });
  }

  verifyUserInvite(token: string, currentPasswordHash: string): { userId: string } | null {
    const payload = this.verifyAndDecode(token);
    if (!payload || payload.purpose !== 'USER_INVITE' || !payload.bindingFingerprint) return null;
    const expected = crypto.createHash('sha256').update(currentPasswordHash).digest('base64url');
    if (payload.bindingFingerprint !== expected) return null;
    return { userId: payload.userId };
  }

  issuePasswordReset(userId: string, currentPasswordHash: string, ttlMs = 30 * 60 * 1000): string {
    const bindingFingerprint = crypto.createHash('sha256').update(currentPasswordHash).digest('base64url');
    return this.sign({ purpose: 'PASSWORD_RESET', userId, bindingFingerprint, expiresAt: Date.now() + ttlMs });
  }

  verifyPasswordReset(token: string, currentPasswordHash: string): { userId: string } | null {
    const payload = this.verifyAndDecode(token);
    if (!payload || payload.purpose !== 'PASSWORD_RESET' || !payload.bindingFingerprint) return null;
    const expected = crypto.createHash('sha256').update(currentPasswordHash).digest('base64url');
    if (payload.bindingFingerprint !== expected) return null; // password already changed — token dead
    return { userId: payload.userId };
  }
}
