import { Injectable, UnauthorizedException, BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PasswordService } from './services/password.service';
import { TotpService } from './services/totp.service';
import { ChallengeTokenService } from './services/challenge-token.service';
import { SessionService, SessionInfo } from './services/session.service';
import { AuditService } from '../audit/services/audit.service';
import { LoginDto } from './dto/login.dto';
import { VerifyMfaDto } from './dto/verify-mfa.dto';
import { ResetPasswordRequestDto } from './dto/reset-password-request.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

// Fixed, known-invalid argon2id hash (not a secret) used to burn comparable
// time verifying a password when the account doesn't exist, so a missing
// account isn't cheaply distinguishable from a wrong password by timing.
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$3d3RwZ0hQeQnP9U7X8sVJlYq8b1xkFq6UukzC0Y1WkQ';

export interface LoginResult {
  mfaRequired: boolean;
  challengeId?: string;
  session?: SessionInfo;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly totpService: TotpService,
    private readonly challengeTokenService: ChallengeTokenService,
    private readonly sessionService: SessionService,
    private readonly auditService: AuditService,
  ) {}

  async login(dto: LoginDto, ipAddress?: string, userAgent?: string): Promise<LoginResult> {
    // Email is unique per-organization, not globally (schema:
    // @@unique([organizationId, email])), so more than one org could in
    // principle share an email. That's an open question from Phase 1 (§18)
    // not yet resolved by the product — for now we require it to resolve
    // to exactly one account and reject ambiguous matches rather than
    // guessing which org the person means.
    const candidates = await this.prisma.user.findMany({ where: { email: dto.email } });

    if (candidates.length > 1) {
      throw new ConflictException(
        'Multiple organizations use this email. Organization-scoped login is not yet implemented — contact your administrator.',
      );
    }

    const user = candidates[0];

    if (!user) {
      await this.passwordService.verify(DUMMY_HASH, dto.password);
      throw new UnauthorizedException('Invalid email or password.');
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await this.auditService.record({
        organizationId: user.organizationId,
        actorId: user.id,
        action: 'auth.login.blocked_locked',
        resourceType: 'User',
        resourceId: user.id,
        ipAddress,
        userAgent,
      });
      throw new UnauthorizedException('Account is temporarily locked due to repeated failed login attempts.');
    }

    if (user.status !== 'ACTIVE') {
      throw new UnauthorizedException('Invalid email or password.');
    }

    const organization = await this.prisma.organization.findUnique({ where: { id: user.organizationId } });
    if (!organization || organization.status !== 'ACTIVE') {
      // Password isn't checked at all here: an org-level block applies
      // regardless of credential correctness, and we don't want a disabled
      // org's users probing whether their password still works.
      throw new UnauthorizedException('This organization is not currently active.');
    }

    const passwordValid = await this.passwordService.verify(user.passwordHash, dto.password);

    if (!passwordValid) {
      const failedLoginCount = user.failedLoginCount + 1;
      const lockingOut = failedLoginCount >= MAX_FAILED_ATTEMPTS;
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: lockingOut ? 0 : failedLoginCount,
          lockedUntil: lockingOut ? new Date(Date.now() + LOCKOUT_DURATION_MS) : null,
        },
      });
      await this.auditService.record({
        organizationId: user.organizationId,
        actorId: user.id,
        action: lockingOut ? 'auth.login.failed_lockout_triggered' : 'auth.login.failed',
        resourceType: 'User',
        resourceId: user.id,
        ipAddress,
        userAgent,
      });
      throw new UnauthorizedException('Invalid email or password.');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null },
    });

    const mfaFactor = await this.prisma.mfaFactor.findFirst({
      where: { userId: user.id, verified: true },
    });

    await this.auditService.record({
      organizationId: user.organizationId,
      actorId: user.id,
      action: 'auth.login.password_verified',
      resourceType: 'User',
      resourceId: user.id,
      ipAddress,
      userAgent,
    });

    if (mfaFactor) {
      const challengeId = this.challengeTokenService.issueMfaPending(user.id);
      return { mfaRequired: true, challengeId };
    }

    const session = await this.sessionService.create(user.id, userAgent, ipAddress);
    await this.auditService.record({
      organizationId: user.organizationId,
      actorId: user.id,
      action: 'auth.login.success',
      resourceType: 'Session',
      resourceId: session.id,
      ipAddress,
      userAgent,
    });
    return { mfaRequired: false, session };
  }

  async verifyMfa(dto: VerifyMfaDto, ipAddress?: string, userAgent?: string): Promise<LoginResult> {
    const pending = this.challengeTokenService.verifyMfaPending(dto.challengeId);
    if (!pending) {
      throw new UnauthorizedException('MFA challenge is invalid or has expired.');
    }

    const user = await this.prisma.user.findUnique({ where: { id: pending.userId } });
    const factor = await this.prisma.mfaFactor.findFirst({
      where: { userId: pending.userId, verified: true },
    });

    if (!user || !factor) {
      throw new UnauthorizedException('MFA challenge is invalid or has expired.');
    }

    const secret = this.totpService.decryptSecret(factor.secretEncrypted);
    const valid = this.totpService.verify(secret, dto.code);

    if (!valid) {
      await this.auditService.record({
        organizationId: user.organizationId,
        actorId: user.id,
        action: 'auth.mfa.failed',
        resourceType: 'User',
        resourceId: user.id,
        ipAddress,
        userAgent,
      });
      throw new UnauthorizedException('Invalid MFA code.');
    }

    const session = await this.sessionService.create(user.id, userAgent, ipAddress);
    await this.auditService.record({
      organizationId: user.organizationId,
      actorId: user.id,
      action: 'auth.mfa.success',
      resourceType: 'Session',
      resourceId: session.id,
      ipAddress,
      userAgent,
    });
    return { mfaRequired: false, session };
  }

  async logout(sessionId: string, userId: string, organizationId: string): Promise<void> {
    await this.sessionService.revoke(sessionId);
    await this.auditService.record({
      organizationId,
      actorId: userId,
      action: 'auth.logout',
      resourceType: 'Session',
      resourceId: sessionId,
    });
  }

  async enrollMfaStart(userId: string): Promise<{ secret: string; otpauthUrl: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();

    const existingVerified = await this.prisma.mfaFactor.findFirst({ where: { userId, verified: true } });
    if (existingVerified) {
      throw new ConflictException('MFA is already enrolled for this account.');
    }

    const secret = this.totpService.generateSecret();
    const encrypted = this.totpService.encryptSecret(secret);

    await this.prisma.mfaFactor.deleteMany({ where: { userId, verified: false } });
    await this.prisma.mfaFactor.create({
      data: { userId, type: 'TOTP', secretEncrypted: encrypted, verified: false },
    });

    return { secret, otpauthUrl: this.totpService.keyUri(secret, user.email) };
  }

  async enrollMfaConfirm(userId: string, code: string): Promise<void> {
    const factor = await this.prisma.mfaFactor.findFirst({ where: { userId, verified: false } });
    if (!factor) {
      throw new BadRequestException('No pending MFA enrollment found. Start enrollment first.');
    }
    const secret = this.totpService.decryptSecret(factor.secretEncrypted);
    if (!this.totpService.verify(secret, code)) {
      throw new UnauthorizedException('Invalid MFA code.');
    }
    await this.prisma.mfaFactor.update({ where: { id: factor.id }, data: { verified: true } });

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    await this.auditService.record({
      organizationId: user?.organizationId,
      actorId: userId,
      action: 'auth.mfa.enrolled',
      resourceType: 'User',
      resourceId: userId,
    });
  }

  /**
   * Always resolves without revealing whether the email matched an account.
   * Reset-link delivery belongs to the Notifications module (Phase 12); until
   * that exists, the token is logged server-side only — never returned in
   * the API response.
   */
  async requestPasswordReset(dto: ResetPasswordRequestDto): Promise<void> {
    const candidates = await this.prisma.user.findMany({ where: { email: dto.email } });
    for (const user of candidates) {
      const token = this.challengeTokenService.issuePasswordReset(user.id, user.passwordHash);
      // TODO(Phase 12): replace with NotificationsService email delivery.
      // eslint-disable-next-line no-console
      console.log(`[password-reset] token for ${user.email} (user ${user.id}): ${token}`);
      await this.auditService.record({
        organizationId: user.organizationId,
        actorId: user.id,
        action: 'auth.password_reset.requested',
        resourceType: 'User',
        resourceId: user.id,
      });
    }
  }

  async resetPassword(dto: ResetPasswordDto): Promise<void> {
    const candidateUserId = this.peekUnverifiedUserId(dto.token);
    if (!candidateUserId) {
      throw new BadRequestException('Invalid or expired reset token.');
    }
    const user = await this.prisma.user.findUnique({ where: { id: candidateUserId } });
    if (!user) {
      throw new BadRequestException('Invalid or expired reset token.');
    }
    const verified = this.challengeTokenService.verifyPasswordReset(dto.token, user.passwordHash);
    if (!verified) {
      throw new BadRequestException('Invalid or expired reset token.');
    }

    const newHash = await this.passwordService.hash(dto.newPassword);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: newHash, failedLoginCount: 0, lockedUntil: null },
    });
    await this.sessionService.revokeAllForUser(user.id);
    await this.auditService.record({
      organizationId: user.organizationId,
      actorId: user.id,
      action: 'auth.password_reset.completed',
      resourceType: 'User',
      resourceId: user.id,
    });
  }

  /** Reads the (unverified-at-this-point) userId out of a challenge token's payload, without trusting it yet — the caller must still call the matching verify*() method before acting on anything. */
  private peekUnverifiedUserId(token: string): string | null {
    try {
      const [body] = token.split('.');
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      return typeof payload.userId === 'string' ? payload.userId : null;
    } catch {
      return null;
    }
  }
}
