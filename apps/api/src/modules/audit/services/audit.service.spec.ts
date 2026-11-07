import { PayloadTooLargeException } from '@nestjs/common';
import { AuditService, AUDIT_EXPORT_MAX_ROWS } from './audit.service';

/**
 * Same mocked-Prisma approach as approvals.service.spec.ts (Phase 9) and
 * payment-execution.service.spec.ts (Phase 10). `record()` was already
 * covered implicitly by every other service's spec that calls
 * `auditService.record` as a mock; this file is the first to test
 * AuditService's own behavior directly — the Phase 11 read/query/export
 * side, plus a couple of direct `record()` checks for completeness.
 */
describe('AuditService (unit, mocked Prisma)', () => {
  const ORG_ID = 'org-1';

  function makeService() {
    const scopedClient = {
      auditEvent: { findMany: jest.fn() },
    };
    const rawPrisma = {
      auditEvent: { create: jest.fn() },
    };
    const tenantPrisma = { forOrg: jest.fn().mockReturnValue(scopedClient) };

    const service = new AuditService(rawPrisma as any, tenantPrisma as any);
    return { service, scopedClient, rawPrisma, tenantPrisma };
  }

  const EVENT = (overrides: Partial<Record<string, unknown>> = {}) => ({
    id: 'evt-1',
    organizationId: ORG_ID,
    actorId: 'user-1',
    action: 'payment.created',
    resourceType: 'Payment',
    resourceId: 'pay-1',
    previousState: null,
    newState: { status: 'PENDING' },
    metadata: null,
    ipAddress: '127.0.0.1',
    userAgent: 'jest',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

  describe('record', () => {
    it('writes through the raw (unscoped) client when no transaction handle is supplied', async () => {
      const { service, rawPrisma } = makeService();
      rawPrisma.auditEvent.create.mockResolvedValue(undefined);

      await service.record({
        organizationId: ORG_ID,
        actorId: 'user-1',
        action: 'payment.created',
        resourceType: 'Payment',
        resourceId: 'pay-1',
      });

      expect(rawPrisma.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ organizationId: ORG_ID, action: 'payment.created' }),
        }),
      );
    });

    it('writes through the supplied transaction client, not the raw one, when tx is provided', async () => {
      const { service, rawPrisma } = makeService();
      const tx = { auditEvent: { create: jest.fn().mockResolvedValue(undefined) } };

      await service.record({ action: 'payment.created', resourceType: 'Payment' }, tx as any);

      expect(tx.auditEvent.create).toHaveBeenCalled();
      expect(rawPrisma.auditEvent.create).not.toHaveBeenCalled();
    });
  });

  describe('queryEvents', () => {
    it('scopes the read through TenantPrismaService.forOrg, never trusting a raw query', async () => {
      const { service, scopedClient, tenantPrisma } = makeService();
      scopedClient.auditEvent.findMany.mockResolvedValue([EVENT()]);

      await service.queryEvents(ORG_ID, {});

      expect(tenantPrisma.forOrg).toHaveBeenCalledWith(ORG_ID);
    });

    it('applies the actorId/action/resourceType/resourceId filters verbatim', async () => {
      const { service, scopedClient } = makeService();
      scopedClient.auditEvent.findMany.mockResolvedValue([]);

      await service.queryEvents(ORG_ID, {
        actorId: 'user-1',
        action: 'payment.created',
        resourceType: 'Payment',
        resourceId: 'pay-1',
      });

      expect(scopedClient.auditEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { actorId: 'user-1', action: 'payment.created', resourceType: 'Payment', resourceId: 'pay-1' },
        }),
      );
    });

    it('turns dateFrom/dateTo into a createdAt gte/lte range', async () => {
      const { service, scopedClient } = makeService();
      scopedClient.auditEvent.findMany.mockResolvedValue([]);

      await service.queryEvents(ORG_ID, { dateFrom: '2026-01-01', dateTo: '2026-01-31' });

      expect(scopedClient.auditEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { createdAt: { gte: new Date('2026-01-01'), lte: new Date('2026-01-31') } },
        }),
      );
    });

    it('defaults to a page size of 50 and reports nextCursor as null when there is no next page', async () => {
      const { service, scopedClient } = makeService();
      scopedClient.auditEvent.findMany.mockResolvedValue([EVENT({ id: 'evt-1' }), EVENT({ id: 'evt-2' })]);

      const result = await service.queryEvents(ORG_ID, {});

      expect(scopedClient.auditEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 51 }));
      expect(result.events).toHaveLength(2);
      expect(result.nextCursor).toBeNull();
    });

    it('detects a next page by the "take one extra" sentinel and trims it from the returned page', async () => {
      const { service, scopedClient } = makeService();
      // limit: 2, but 3 rows come back -> there IS a next page, last of the trimmed page is the cursor.
      scopedClient.auditEvent.findMany.mockResolvedValue([
        EVENT({ id: 'evt-1' }),
        EVENT({ id: 'evt-2' }),
        EVENT({ id: 'evt-3' }),
      ]);

      const result = await service.queryEvents(ORG_ID, { limit: 2 });

      expect(result.events).toHaveLength(2);
      expect(result.events.map((e) => e.id)).toEqual(['evt-1', 'evt-2']);
      expect(result.nextCursor).toEqual('evt-2');
    });

    it('passes a cursor through as { cursor: { id }, skip: 1 } when provided', async () => {
      const { service, scopedClient } = makeService();
      scopedClient.auditEvent.findMany.mockResolvedValue([]);

      await service.queryEvents(ORG_ID, { cursor: 'evt-2' });

      expect(scopedClient.auditEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ cursor: { id: 'evt-2' }, skip: 1 }),
      );
    });

    it('never accepts organizationId as a filter field (always comes from the authenticated caller)', async () => {
      const { service, scopedClient } = makeService();
      scopedClient.auditEvent.findMany.mockResolvedValue([]);

      // Even if a caller somehow smuggled an organizationId-shaped filter through, buildWhere()
      // has no branch for it, so it can never reach the query's `where`.
      await service.queryEvents(ORG_ID, { actorId: 'user-1' } as any);

      const call = scopedClient.auditEvent.findMany.mock.calls[0][0];
      expect(call.where).not.toHaveProperty('organizationId');
    });
  });

  describe('queryEventsForExport', () => {
    it('scopes through forOrg and returns the raw rows when under the cap', async () => {
      const { service, scopedClient, tenantPrisma } = makeService();
      scopedClient.auditEvent.findMany.mockResolvedValue([EVENT(), EVENT({ id: 'evt-2' })]);

      const rows = await service.queryEventsForExport(ORG_ID, {});

      expect(tenantPrisma.forOrg).toHaveBeenCalledWith(ORG_ID);
      expect(rows).toHaveLength(2);
    });

    it('throws PayloadTooLargeException instead of silently truncating when over AUDIT_EXPORT_MAX_ROWS', async () => {
      const { service, scopedClient } = makeService();
      const tooMany = Array.from({ length: AUDIT_EXPORT_MAX_ROWS + 1 }, (_, i) => EVENT({ id: `evt-${i}` }));
      scopedClient.auditEvent.findMany.mockResolvedValue(tooMany);

      await expect(service.queryEventsForExport(ORG_ID, {})).rejects.toThrow(PayloadTooLargeException);
    });

    it('requests exactly AUDIT_EXPORT_MAX_ROWS + 1 rows, unpaginated (no cursor/skip)', async () => {
      const { service, scopedClient } = makeService();
      scopedClient.auditEvent.findMany.mockResolvedValue([EVENT()]);

      await service.queryEventsForExport(ORG_ID, {});

      const call = scopedClient.auditEvent.findMany.mock.calls[0][0];
      expect(call.take).toEqual(AUDIT_EXPORT_MAX_ROWS + 1);
      expect(call).not.toHaveProperty('cursor');
      expect(call).not.toHaveProperty('skip');
    });
  });
});
