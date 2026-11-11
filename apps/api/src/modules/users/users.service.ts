import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import { TenantPrismaService } from '../../common/prisma/tenant-prisma.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PasswordService } from '../auth/services/password.service';
import { ChallengeTokenService } from '../auth/services/challenge-token.service';
import { SessionService } from '../auth/services/session.service';
import { AuditService } from '../audit/services/audit.service';
import { InviteUserDto } from './dto/invite-user.dto';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import { UpdateUserRolesDto } from './dto/update-user-roles.dto';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService, // used only pre-auth, in acceptInvite — see comment there
    private readonly tenantPrisma: TenantPrismaService,
    private readonly passwordService: PasswordService,
    private readonly challengeTokenService: ChallengeTokenService,
    private readonly sessionService: SessionService,
    private readonly auditService: AuditService,
  ) {}

  async listUsers(organizationId: string) {
    const scoped = this.tenantPrisma.forOrg(organizationId);
    return scoped.user.findMany({
      select: {
        id: true,
        email: true,
        status: true,
        createdAt: true,
        userRoles: { select: { role: { select: { id: true, name: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async inviteUser(organizationId: string, actorUserId: string, dto: InviteUserDto) {
    const scoped = this.tenantPrisma.forOrg(organizationId);

    const existing = await this.prisma.user.findFirst({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException('A user with this email already exists.');
    }

    const roles = await scoped.role.findMany({ where: { name: { in: dto.roleNames } } });
    const foundNames = new Set(roles.map((r: { name: string }) => r.name));
    const missing = dto.roleNames.filter((n) => !foundNames.has(n));
    if (missing.length > 0) {
      throw new BadRequestException(`Unknown role(s): ${missing.join(', ')}`);
    }

    // Unusable placeholder hash — this user cannot authenticate until they
    // accept the invite and set a real password, which replaces this value
    // (and in doing so invalidates the invite token, since it's bound to
    // this hash — see ChallengeTokenService.issueUserInvite).
    const placeholderHash = await this.passwordService.hash(crypto.randomBytes(32).toString('hex'));

    const user = await scoped.user.create({
      data: {
        organizationId, // also injected/verified by the tenant extension
        email: dto.email,
        passwordHash: placeholderHash,
        status: 'INVITED',
        userRoles: { create: roles.map((r: { id: string }) => ({ roleId: r.id })) },
      },
    });

    const token = this.challengeTokenService.issueUserInvite(user.id, placeholderHash);
    // TODO(Phase 12): replace with NotificationsService email delivery.
    // eslint-disable-next-line no-console
    console.log(`[user-invite] token for ${user.email} (user ${user.id}): ${token}`);

    await this.auditService.record({
      organizationId,
      actorId: actorUserId,
      action: 'user.invited',
      resourceType: 'User',
      resourceId: user.id,
      newState: { email: user.email, roles: dto.roleNames },
    });

    return { userId: user.id, email: user.email };
  }

  /**
   * Pre-authentication by definition (the person has no session yet), so
   * this is one of the few legitimate uses of the raw PrismaService rather
   * than a tenant-scoped client — there is no caller organizationId to
   * scope by until the token is decoded and the user (and therefore their
   * org) is identified.
   */
  async acceptInvite(dto: AcceptInviteDto) {
    const candidateUserId = this.peekUnverifiedUserId(dto.token);
    if (!candidateUserId) {
      throw new BadRequestException('Invalid or expired invite token.');
    }
    const user = await this.prisma.user.findUnique({ where: { id: candidateUserId } });
    if (!user || user.status !== 'INVITED') {
      throw new BadRequestException('Invalid or expired invite token.');
    }
    const verified = this.challengeTokenService.verifyUserInvite(dto.token, user.passwordHash);
    if (!verified) {
      throw new BadRequestException('Invalid or expired invite token.');
    }

    const newHash = await this.passwordService.hash(dto.password);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: newHash, status: 'ACTIVE' },
    });

    await this.auditService.record({
      organizationId: user.organizationId,
      actorId: user.id,
      action: 'user.invite_accepted',
      resourceType: 'User',
      resourceId: user.id,
    });

    return { success: true };
  }

  async updateUserRoles(organizationId: string, actorUserId: string, targetUserId: string, dto: UpdateUserRolesDto) {
    const scoped = this.tenantPrisma.forOrg(organizationId);

    const target = await scoped.user.findUnique({ where: { id: targetUserId } });
    if (!target) throw new NotFoundException();

    const roles = await scoped.role.findMany({ where: { name: { in: dto.roleNames } } });
    const foundNames = new Set(roles.map((r: { name: string }) => r.name));
    const missing = dto.roleNames.filter((n) => !foundNames.has(n));
    if (missing.length > 0) {
      throw new BadRequestException(`Unknown role(s): ${missing.join(', ')}`);
    }

    const previousRoles = await this.prisma.userRole.findMany({
      where: { userId: targetUserId },
      select: { role: { select: { name: true } } },
    });

    await this.prisma.$transaction([
      this.prisma.userRole.deleteMany({ where: { userId: targetUserId } }),
      this.prisma.userRole.createMany({
        data: roles.map((r: { id: string }) => ({ userId: targetUserId, roleId: r.id })),
      }),
    ]);

    await this.auditService.record({
      organizationId,
      actorId: actorUserId,
      action: 'user.roles_updated',
      resourceType: 'User',
      resourceId: targetUserId,
      previousState: { roles: previousRoles.map((r: { role: { name: string } }) => r.role.name) },
      newState: { roles: dto.roleNames },
    });

    return { userId: targetUserId, roles: dto.roleNames };
  }

  async setUserStatus(organizationId: string, actorUserId: string, targetUserId: string, active: boolean) {
    const scoped = this.tenantPrisma.forOrg(organizationId);

    const target = await scoped.user.findUnique({ where: { id: targetUserId } });
    if (!target) throw new NotFoundException();

    if (targetUserId === actorUserId && !active) {
      throw new BadRequestException('You cannot disable your own account.');
    }

    await scoped.user.update({
      where: { id: targetUserId },
      data: { status: active ? 'ACTIVE' : 'DISABLED' },
    });

    if (!active) {
      await this.sessionService.revokeAllForUser(targetUserId);
    }

    await this.auditService.record({
      organizationId,
      actorId: actorUserId,
      action: active ? 'user.enabled' : 'user.disabled',
      resourceType: 'User',
      resourceId: targetUserId,
    });

    return { userId: targetUserId, status: active ? 'ACTIVE' : 'DISABLED' };
  }

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
