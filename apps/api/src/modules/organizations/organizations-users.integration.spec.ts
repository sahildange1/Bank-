import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantPrismaService } from '../../common/prisma/tenant-prisma.service';
import { AuditService } from '../audit/services/audit.service';
import { PasswordService } from '../auth/services/password.service';
import { TotpService } from '../auth/services/totp.service';
import { ChallengeTokenService } from '../auth/services/challenge-token.service';
import { SessionService } from '../auth/services/session.service';
import { AuthService } from '../auth/auth.service';
import { OrganizationsService } from './organizations.service';
import { UsersService } from '../users/users.service';
import { DEFAULT_ADMIN_ROLE_NAME, PERMISSIONS } from './constants/rbac-catalog';

/**
 * Same limitation as tenant-scope.extension.integration.spec.ts: requires a
 * real, generated Prisma client, which this sandbox cannot produce (see
 * Phase 3/4 notes). Run with:
 *
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/corporate_banking \
 *   npx jest --config jest.integration.config.js organizations-users
 *
 * after `prisma generate`, `prisma migrate deploy`, and `prisma:seed` have
 * run with full network access. This exercises the full Phase 5 journey:
 * signup -> default role provisioning -> invite -> accept -> role update ->
 * disable, plus the org-status login gate added in this phase.
 */
describe('Organizations & Users (integration)', () => {
  let prisma: PrismaClient;
  let organizationsService: OrganizationsService;
  let usersService: UsersService;
  let authService: AuthService;
  let createdOrgIds: string[] = [];

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET ??= 'x'.repeat(32);
    process.env.MFA_ENCRYPTION_KEY ??= 'y'.repeat(32);

    const moduleRef = await Test.createTestingModule({
      providers: [
        PrismaService,
        TenantPrismaService,
        AuditService,
        PasswordService,
        TotpService,
        ChallengeTokenService,
        SessionService,
        AuthService,
        OrganizationsService,
        UsersService,
      ],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    organizationsService = moduleRef.get(OrganizationsService);
    usersService = moduleRef.get(UsersService);
    authService = moduleRef.get(AuthService);

    // Prerequisite: global permission catalog must be seeded, same as prisma:seed.
    for (const p of PERMISSIONS) {
      await prisma.permission.upsert({ where: { key: p.key }, update: {}, create: p });
    }
  });

  afterAll(async () => {
    await prisma.userRole.deleteMany({});
    await prisma.rolePermission.deleteMany({ where: { role: { organizationId: { in: createdOrgIds } } } });
    await prisma.role.deleteMany({ where: { organizationId: { in: createdOrgIds } } });
    await prisma.session.deleteMany({});
    await prisma.user.deleteMany({ where: { organizationId: { in: createdOrgIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
    await prisma.$disconnect();
  });

  it('provisions all default roles with correct permission sets on signup', async () => {
    const { organizationId, adminUserId } = await organizationsService.createOrganization({
      legalName: 'Acme Corp',
      adminEmail: 'admin@acme.test',
      adminPassword: 'correct-horse-battery',
    });
    createdOrgIds.push(organizationId);

    // Signup is gated behind platform-operator approval (architecture decision #2).
    const org = await prisma.organization.findUnique({ where: { id: organizationId } });
    expect(org?.status).toEqual('PENDING');
    await expect(authService.login({ email: 'admin@acme.test', password: 'correct-horse-battery' })).rejects.toThrow(
      /not currently active/,
    );

    const roles = await prisma.role.findMany({
      where: { organizationId },
      include: { rolePermissions: { include: { permission: true } } },
    });
    expect(roles.map((r: { name: string }) => r.name).sort()).toEqual(
      ['Auditor', 'Finance Manager', 'Organization Admin', 'Payment Approver', 'Payment Maker', 'Viewer'].sort(),
    );

    const adminRole = roles.find((r: { name: string }) => r.name === DEFAULT_ADMIN_ROLE_NAME)!;
    expect(adminRole.rolePermissions.map((rp: { permission: { key: string } }) => rp.permission.key).sort()).toEqual(
      PERMISSIONS.map((p) => p.key).sort(),
    );

    const adminUser = await prisma.user.findUnique({ where: { id: adminUserId } });
    expect(adminUser?.status).toEqual('ACTIVE');
  });

  it('full flow: invite -> login blocked (INVITED) -> accept -> login succeeds -> role change -> disable blocks login', async () => {
    const { organizationId, adminUserId } = await organizationsService.createOrganization({
      legalName: 'Globex Inc',
      adminEmail: 'admin@globex.test',
      adminPassword: 'correct-horse-battery',
    });
    createdOrgIds.push(organizationId);
    // Stand-in for a platform operator's approval (see AdminService.changeStatus).
    await prisma.organization.update({ where: { id: organizationId }, data: { status: 'ACTIVE' } });

    const { userId } = await usersService.inviteUser(organizationId, adminUserId, {
      email: 'maker@globex.test',
      roleNames: ['Payment Maker'],
    });

    // Can't log in yet — still INVITED, and real password is unknown (placeholder hash).
    await expect(authService.login({ email: 'maker@globex.test', password: 'irrelevant' })).rejects.toThrow();

    // Simulate accepting the invite: issue a real token the way the service does internally.
    const invitedUser = await prisma.user.findUnique({ where: { id: userId } });
    const challengeTokenService = new ChallengeTokenService();
    const inviteToken = challengeTokenService.issueUserInvite(userId, invitedUser!.passwordHash);
    await usersService.acceptInvite({ token: inviteToken, password: 'a-real-password-123' });

    const loginResult = await authService.login({ email: 'maker@globex.test', password: 'a-real-password-123' });
    expect(loginResult.mfaRequired).toBe(false);
    expect(loginResult.session).toBeDefined();

    // Role change persists correctly.
    await usersService.updateUserRoles(organizationId, adminUserId, userId, { roleNames: ['Viewer'] });
    const rolesAfter = await prisma.userRole.findMany({ where: { userId }, include: { role: true } });
    expect(rolesAfter.map((r: { role: { name: string } }) => r.role.name)).toEqual(['Viewer']);

    // Disabling blocks subsequent login and revokes existing sessions.
    await usersService.setUserStatus(organizationId, adminUserId, userId, false);
    await expect(
      authService.login({ email: 'maker@globex.test', password: 'a-real-password-123' }),
    ).rejects.toThrow();
  });

  it('blocks login entirely when the organization is not ACTIVE, even with the correct password', async () => {
    const { organizationId } = await organizationsService.createOrganization({
      legalName: 'Initech',
      adminEmail: 'admin@initech.test',
      adminPassword: 'correct-horse-battery',
    });
    createdOrgIds.push(organizationId);

    await prisma.organization.update({ where: { id: organizationId }, data: { status: 'ACTIVE' } });
    await expect(
      authService.login({ email: 'admin@initech.test', password: 'correct-horse-battery' }),
    ).resolves.toBeDefined(); // control: an ACTIVE org can sign in
    await prisma.organization.update({ where: { id: organizationId }, data: { status: 'SUSPENDED' } });

    await expect(
      authService.login({ email: 'admin@initech.test', password: 'correct-horse-battery' }),
    ).rejects.toThrow();
  });
});
