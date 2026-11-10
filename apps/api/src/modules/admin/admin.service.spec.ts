import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AdminService } from './admin.service';
import { OrganizationStateMachine } from './services/organization-state-machine';

describe('AdminService (unit, mocked Prisma)', () => {
  function makeService(org: any) {
    const tx = {
      organization: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), findUnique: jest.fn() },
      session: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
    };
    const prisma = {
      organization: { findUnique: jest.fn().mockResolvedValue(org), findMany: jest.fn(), findFirst: jest.fn(), groupBy: jest.fn() },
      user: { findMany: jest.fn().mockResolvedValue([{ id: 'admin-1' }]), groupBy: jest.fn() },
      payment: { groupBy: jest.fn() },
      auditEvent: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const notifications = { notify: jest.fn().mockResolvedValue(undefined) };
    const service = new AdminService(prisma as any, audit as any, notifications as any, new OrganizationStateMachine());
    return { service, prisma, tx, audit, notifications };
  }
  const ORG = (status: string, extra = {}) => ({ id: 'org-1', status, isPlatform: false, ...extra });

  it('approve: PENDING -> ACTIVE, audited in the same transaction, admins notified after', async () => {
    const { service, tx, audit, notifications } = makeService(ORG('PENDING'));
    await expect(service.changeStatus('op-1', 'plat', 'org-1', 'approve')).resolves.toEqual({ id: 'org-1', status: 'ACTIVE' });
    expect(tx.organization.updateMany).toHaveBeenCalledWith({
      where: { id: 'org-1', status: 'PENDING', isPlatform: false },
      data: { status: 'ACTIVE' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'platform.organization.approved',
        organizationId: 'org-1',
        actorId: 'op-1',
        previousState: { status: 'PENDING' },
        newState: { status: 'ACTIVE' },
      }),
      tx,
    );
    expect(tx.session.updateMany).not.toHaveBeenCalled();
    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'admin-1', type: 'organization.approved', email: true }),
    );
  });

  it('suspend: revokes every live session of the organization immediately, with the reason audited', async () => {
    const { service, tx, audit, notifications } = makeService(ORG('ACTIVE'));
    await service.changeStatus('op-1', 'plat', 'org-1', 'suspend', 'fraud review');
    expect(tx.session.updateMany).toHaveBeenCalledWith({
      where: { revokedAt: null, user: { organizationId: 'org-1' } },
      data: { revokedAt: expect.any(Date) },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ reason: 'fraud review' }) }),
      tx,
    );
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('close also revokes sessions', async () => {
    const { service, tx } = makeService(ORG('SUSPENDED'));
    await service.changeStatus('op-1', 'plat', 'org-1', 'close', 'requested by customer');
    expect(tx.session.updateMany).toHaveBeenCalled();
  });

  it('rejects an invalid transition with 409 and changes nothing', async () => {
    const { service, prisma } = makeService(ORG('CLOSED'));
    await expect(service.changeStatus('op-1', 'plat', 'org-1', 'reactivate')).rejects.toThrow(ConflictException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses to modify the platform organization itself', async () => {
    const { service, prisma } = makeService(ORG('ACTIVE', { isPlatform: true }));
    await expect(service.changeStatus('op-1', 'plat', 'org-1', 'suspend', 'x')).rejects.toThrow(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('404s for an unknown organization', async () => {
    const { service } = makeService(null);
    await expect(service.changeStatus('op-1', 'plat', 'nope', 'approve')).rejects.toThrow(NotFoundException);
  });

  it('loses a race cleanly: compare-and-set count 0 -> 409 and no audit row or session revoke', async () => {
    const { service, tx, audit } = makeService(ORG('PENDING'));
    tx.organization.updateMany.mockResolvedValue({ count: 0 });
    tx.organization.findUnique.mockResolvedValue({ status: 'ACTIVE' }); // someone else approved first
    await expect(service.changeStatus('op-1', 'plat', 'org-1', 'approve')).rejects.toThrow(ConflictException);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('list never returns the platform organization, and applies status/search filters', async () => {
    const { service, prisma } = makeService(null);
    prisma.organization.findMany.mockResolvedValue([]);
    await service.listOrganizations({ status: 'PENDING', search: 'acme' });
    expect(prisma.organization.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { isPlatform: false, status: 'PENDING', legalName: { contains: 'acme', mode: 'insensitive' } },
      }),
    );
  });

  it('getOrganization 404s for the platform organization (it is not a customer)', async () => {
    const { service, prisma } = makeService(null);
    prisma.organization.findFirst.mockResolvedValue(null);
    await expect(service.getOrganization('plat')).rejects.toThrow(NotFoundException);
    expect(prisma.organization.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'plat', isPlatform: false } }),
    );
  });

  it('stats folds groupBy rows into status maps', async () => {
    const { service, prisma } = makeService(null);
    prisma.organization.groupBy.mockResolvedValue([{ status: 'ACTIVE', _count: { _all: 3 } }]);
    prisma.user.groupBy.mockResolvedValue([{ status: 'ACTIVE', _count: { _all: 9 } }]);
    prisma.payment.groupBy.mockResolvedValue([{ status: 'COMPLETED', _count: { _all: 4 } }]);
    await expect(service.getStats()).resolves.toEqual({
      organizations: { ACTIVE: 3 },
      users: { ACTIVE: 9 },
      payments: { COMPLETED: 4 },
    });
  });
});
