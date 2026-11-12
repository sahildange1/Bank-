import { logDevSecret } from '../../common/dev/dev-secret-log';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
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
import { permissionsMissing } from './role-grant.policy';

type RoleWithPermissions = { rolePermissions: Array<{ permission: { key: string } }> };
const keysOf = (roles: RoleWithPermissions[]) => roles.flatMap((r) => r.rolePermissions.map((rp) => rp.permission.key));

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

  async inviteUser(organizationId: string, actorUserId: string, actorPermissions: readonly string[], dto: InviteUserDto) {
    const scoped = this.tenantPrisma.forOrg(organizationId);

    const existing = await this.prisma.user.findFirst({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException('A user with this email already exists.');
    }

    const roles = await scoped.role.findMany({
      where: { name: { in: dto.roleNames } },
      include: { rolePermissions: { include: { permission: { select: { key: true } } } } },
    });
    const foundNames = new Set(roles.map((r: { name: string }) => r.name));
    const missing = dto.roleNames.filter((n) => !foundNames.has(n));
    if (missing.length > 0) {
      throw new BadRequestException(`Unknown role(s): ${missing.join(', ')}`);
    }
    this.assertMayGrant(actorPermissions, keysOf(roles));

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
    // Email delivery awaits the outbox worker; see logDevSecret for the
    // opt-in, never-in-production local fallback.
    logDevSecret(`[user-invite] token for ${user.email} (user ${user.id}): ${token}`);

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

  async updateUserRoles(
    organizationId: string,
    actorUserId: string,
    actorPermissions: readonly string[],
    targetUserId: string,
    dto: UpdateUserRolesDto,
  ) {
    const scoped = this.tenantPrisma.forOrg(organizationId);

    const target = await scoped.user.findUnique({ where: { id: targetUserId } });
    if (!target) throw new NotFoundException();

    // Changing your own roles is how a limited user would escalate themselves.
    if (targetUserId === actorUserId) {
      throw new ForbiddenException('You cannot change your own roles.');
    }

    const roles = await scoped.role.findMany({
      where: { name: { in: dto.roleNames } },
      include: { rolePermissions: { include: { permission: { select: { key: true } } } } },
    });
    const foundNames = new Set(roles.map((r: { name: string }) => r.name));
    const missing = dto.roleNames.filter((n) => !foundNames.has(n));
    if (missing.length > 0) {
      throw new BadRequestException(`Unknown role(s): ${missing.join(', ')}`);
    }

    const previousRoles = await this.prisma.userRole.findMany({
      where: { userId: targetUserId },
      select: { role: { select: { name: true, rolePermissions: { select: { permission: { select: { key: true } } } } } } },
    });
    // Both directions: you can't grant beyond your own permissions, and you
    // can't strip (demote) someone who holds more than you do.
    this.assertMayGrant(actorPermissions, keysOf(roles));
    this.assertMayGrant(actorPermissions, keysOf(previousRoles.map((r: { role: RoleWithPermissions }) => r.role)));

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

  async setUserStatus(
    organizationId: string,
    actorUserId: string,
    actorPermissions: readonly string[],
    targetUserId: string,
    active: boolean,
  ) {
    const scoped = this.tenantPrisma.forOrg(organizationId);

    const target = await scoped.user.findUnique({ where: { id: targetUserId } });
    if (!target) throw new NotFoundException();

    if (targetUserId === actorUserId && !active) {
      throw new BadRequestException('You cannot disable your own account.');
    }

    // A user manager must not be able to lock out an admin more powerful than themselves.
    const targetRoles = await this.prisma.userRole.findMany({
      where: { userId: targetUserId },
      select: { role: { select: { rolePermissions: { select: { permission: { select: { key: true } } } } } } },
    });
    this.assertMayGrant(actorPermissions, keysOf(targetRoles.map((r: { role: RoleWithPermissions }) => r.role)));

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

  private assertMayGrant(actorPermissions: readonly string[], needed: string[]) {
    const missing = permissionsMissing(actorPermissions, needed);
    if (missing.length > 0) {
      throw new ForbiddenException('You cannot assign, remove or modify roles that carry permissions you do not hold.');
    }
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
