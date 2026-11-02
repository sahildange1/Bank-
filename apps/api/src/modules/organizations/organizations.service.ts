import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PasswordService } from '../auth/services/password.service';
import { AuditService } from '../audit/services/audit.service';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { DEFAULT_ADMIN_ROLE_NAME, DEFAULT_ROLE_PERMISSIONS } from './constants/rbac-catalog';
import { DEFAULT_APPROVAL_POLICY } from './constants/default-approval-policy';

@Injectable()
export class OrganizationsService {
  constructor(
    // Deliberately the raw/unscoped client, not TenantPrismaService.forOrg():
    // organization creation is the one place that is inherently pre-tenant —
    // there is no organizationId to scope by yet. See TenantPrismaService.raw()
    // doc comment for why this escape hatch exists and is reviewed.
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Self-service signup, resolving the Phase 1 open question (§18 #2)
   * pragmatically for this prototype: the organization is created ACTIVE
   * immediately rather than gated behind a manual admin-approval queue.
   * `OrgStatus` still has PENDING/SUSPENDED/CLOSED for when the Admin
   * Portal (Phase 13) adds a real approval/suspension workflow — this
   * doesn't foreclose that, it just doesn't block on it existing yet.
   */
  async createOrganization(dto: CreateOrganizationDto) {
    const existingAdmin = await this.prisma.user.findFirst({ where: { email: dto.adminEmail } });
    if (existingAdmin) {
      // Safe to reveal here (unlike login): this is a signup flow, and the
      // alternative (silently succeeding) would just confuse the caller.
      throw new ConflictException('An account with this email already exists.');
    }

    const passwordHash = await this.passwordService.hash(dto.adminPassword);

    const organization = await this.prisma.organization.create({
      data: { legalName: dto.legalName, status: 'ACTIVE' },
    });

    // Materialize this org's default roles from the shared template, then
    // its first user as Organization Admin. Roles aren't tenant-scoped via
    // TenantPrismaService here because the org didn't exist a moment ago —
    // from this point on, everything else uses the scoped client.
    const roleIdByName = await this.provisionDefaultRoles(organization.id);

    // See constants/default-approval-policy.ts: Phase 8 (Payments) needs
    // every org to have at least one ApprovalPolicy to resolve at
    // submission time, before Phase 9 builds real policy management.
    await this.prisma.approvalPolicy.create({
      data: { organizationId: organization.id, ...DEFAULT_APPROVAL_POLICY },
    });

    const adminUser = await this.prisma.user.create({
      data: {
        organizationId: organization.id,
        email: dto.adminEmail,
        passwordHash,
        status: 'ACTIVE',
        userRoles: {
          create: [{ roleId: roleIdByName.get(DEFAULT_ADMIN_ROLE_NAME)! }],
        },
      },
    });

    await this.auditService.record({
      organizationId: organization.id,
      actorId: adminUser.id,
      action: 'organization.created',
      resourceType: 'Organization',
      resourceId: organization.id,
      newState: { legalName: organization.legalName, status: organization.status },
    });

    return { organizationId: organization.id, adminUserId: adminUser.id };
  }

  /** Creates this org's Role/RolePermission rows from DEFAULT_ROLE_PERMISSIONS. Assumes the global Permission catalog is already seeded (prisma/seed.ts). */
  private async provisionDefaultRoles(organizationId: string): Promise<Map<string, string>> {
    const allPermissions = await this.prisma.permission.findMany();
    const permissionIdByKey = new Map(
      allPermissions.map((p: { key: string; id: string }) => [p.key, p.id]),
    );

    const roleIdByName = new Map<string, string>();
    for (const [roleName, permissionKeys] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
      const missingKeys = permissionKeys.filter((k) => !permissionIdByKey.has(k));
      if (missingKeys.length > 0) {
        throw new Error(
          `Cannot provision role "${roleName}": permissions not seeded: ${missingKeys.join(', ')}. Run prisma:seed first.`,
        );
      }
      const role = await this.prisma.role.create({
        data: {
          organizationId,
          name: roleName,
          isSystemRole: true,
          rolePermissions: {
            create: permissionKeys.map((key) => ({ permissionId: permissionIdByKey.get(key)! })),
          },
        },
      });
      roleIdByName.set(roleName, role.id);
    }
    return roleIdByName;
  }

  /**
   * `Organization` has no organizationId column — it IS the tenant, not a
   * tenant-owned row — so the tenant-scope extension does not filter it
   * (see TENANT_SCOPED_MODELS in tenant-scope.extension.ts). This method is
   * therefore only safe because every caller passes the authenticated
   * user's own `organizationId` (from AuthContext, never from a request
   * param); it must never be wired to a client-supplied org ID.
   */
  async getOrganization(organizationId: string) {
    const organization = await this.prisma.organization.findUnique({ where: { id: organizationId } });
    if (!organization) throw new NotFoundException();
    return organization;
  }
}
