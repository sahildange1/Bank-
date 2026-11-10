import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/services/audit.service';
import { NotificationsService } from '../notifications/services/notifications.service';
import { DEFAULT_ADMIN_ROLE_NAME } from '../organizations/constants/rbac-catalog';
import { ListOrganizationsDto } from './dto/list-organizations.dto';
import { OrgAction, OrganizationStateMachine, OrgStatus } from './services/organization-state-machine';

const EVENT_FOR_ACTION: Record<OrgAction, string> = {
  approve: 'platform.organization.approved',
  suspend: 'platform.organization.suspended',
  reactivate: 'platform.organization.reactivated',
  close: 'platform.organization.closed',
};

/**
 * Cross-tenant by design: this is the one place customer organizations are
 * read and changed from outside their own tenant, so it uses the raw
 * Prisma client instead of TenantPrismaService.forOrg(). That is only safe
 * because every entry point sits behind SessionAuthGuard +
 * PlatformOperatorGuard + a platform.* permission (see AdminController),
 * and because it never touches the platform organization itself.
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly notifications: NotificationsService,
    private readonly stateMachine: OrganizationStateMachine,
  ) {}

  async listOrganizations(filters: ListOrganizationsDto) {
    const take = filters.limit ?? 25;
    const rows = await this.prisma.organization.findMany({
      where: {
        isPlatform: false,
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.search ? { legalName: { contains: filters.search, mode: 'insensitive' } } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
      select: { id: true, legalName: true, status: true, createdAt: true, _count: { select: { users: true } } },
    });
    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    return { organizations: page, nextCursor: hasMore ? page[page.length - 1].id : null };
  }

  async getOrganization(organizationId: string) {
    const org = await this.prisma.organization.findFirst({
      where: { id: organizationId, isPlatform: false },
      select: {
        id: true,
        legalName: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { users: true, accounts: true, payments: true } },
      },
    });
    if (!org) throw new NotFoundException();

    const recentEvents = await this.prisma.auditEvent.findMany({
      where: { organizationId, action: { startsWith: 'platform.organization.' } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 20,
    });
    return { ...org, recentStatusChanges: recentEvents };
  }

  async changeStatus(operatorUserId: string, operatorOrgId: string, organizationId: string, action: OrgAction, reason?: string) {
    const org = await this.prisma.organization.findUnique({ where: { id: organizationId } });
    if (!org) throw new NotFoundException();
    // The platform organization can never be approved/suspended/closed
    // through this API — that would lock every operator out.
    if (org.isPlatform) throw new ForbiddenException('The platform organization cannot be modified here.');

    const from = org.status as OrgStatus;
    const to = this.stateMachine.target(from, action);

    await this.prisma.$transaction(async (tx: any) => {
      // Compare-and-set on the status we validated against, so two
      // operators racing (or a double-click) can't both apply a transition.
      const result = await tx.organization.updateMany({
        where: { id: organizationId, status: from, isPlatform: false },
        data: { status: to },
      });
      if (result.count !== 1) {
        // Someone else changed it first; surface as the same 409 as an invalid transition.
        const fresh = await tx.organization.findUnique({ where: { id: organizationId } });
        this.stateMachine.target((fresh?.status ?? from) as OrgStatus, action);
        throw new NotFoundException();
      }

      // A blocked organization must lose access immediately, not at idle
      // timeout: revoke every live session of its users in the same transaction.
      if (to === 'SUSPENDED' || to === 'CLOSED') {
        await tx.session.updateMany({
          where: { revokedAt: null, user: { organizationId } },
          data: { revokedAt: new Date() },
        });
      }

      await this.auditService.record(
        {
          organizationId,
          actorId: operatorUserId,
          action: EVENT_FOR_ACTION[action],
          resourceType: 'Organization',
          resourceId: organizationId,
          previousState: { status: from },
          newState: { status: to },
          metadata: { ...(reason ? { reason } : {}), operatorOrganizationId: operatorOrgId },
        },
        tx,
      );
    });

    if (action === 'approve') await this.notifyOrganizationAdmins(organizationId);

    return { id: organizationId, status: to };
  }

  async getStats() {
    const [orgsByStatus, usersByStatus, paymentsByStatus] = await Promise.all([
      this.prisma.organization.groupBy({ by: ['status'], where: { isPlatform: false }, _count: { _all: true } }),
      this.prisma.user.groupBy({ by: ['status'], where: { organization: { isPlatform: false } }, _count: { _all: true } }),
      this.prisma.payment.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);
    const toMap = (rows: Array<{ status: string; _count: { _all: number } }>) =>
      Object.fromEntries(rows.map((r) => [r.status, r._count._all]));
    return {
      organizations: toMap(orgsByStatus),
      users: toMap(usersByStatus),
      payments: toMap(paymentsByStatus),
    };
  }

  private async notifyOrganizationAdmins(organizationId: string) {
    const admins = await this.prisma.user.findMany({
      where: {
        organizationId,
        status: 'ACTIVE',
        userRoles: { some: { role: { name: DEFAULT_ADMIN_ROLE_NAME } } },
      },
      select: { id: true },
    });
    for (const admin of admins) {
      await this.notifications.notify({
        organizationId,
        userId: admin.id,
        type: 'organization.approved',
        title: 'Your organization has been approved',
        body: 'Onboarding is complete. You can now sign in and start using the platform.',
        resourceType: 'Organization',
        resourceId: organizationId,
        email: true,
      });
    }
  }
}
