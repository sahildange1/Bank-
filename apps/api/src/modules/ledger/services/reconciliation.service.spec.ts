import { ReconciliationService } from './reconciliation.service';

/**
 * Same mocked-Prisma approach as the rest of this repo's service unit
 * tests. `$queryRaw` is mocked directly since it's a tagged-template
 * function on PrismaService, not a model method.
 */
describe('ReconciliationService (unit, mocked Prisma)', () => {
  const ORG_ID = 'org-1';
  const ACTOR_ID = 'user-1';

  function makeService() {
    const scopedClient = { account: { findMany: jest.fn() } };
    const rawPrisma = {
      $queryRaw: jest.fn(),
      organization: { findMany: jest.fn() },
    };
    const tenantPrisma = { forOrg: jest.fn().mockReturnValue(scopedClient) };
    const auditService = { record: jest.fn().mockResolvedValue(undefined) };

    const service = new ReconciliationService(rawPrisma as any, tenantPrisma as any, auditService as any);
    return { service, scopedClient, rawPrisma, auditService };
  }

  it('reports every account in sync and only writes the summary audit event when nothing drifted', async () => {
    const { service, scopedClient, rawPrisma, auditService } = makeService();
    scopedClient.account.findMany.mockResolvedValue([
      { id: 'acct-1', accountNumber: 'ACC-1', balanceMinorUnits: 10_000n },
      { id: 'acct-2', accountNumber: 'ACC-2', balanceMinorUnits: 0n },
    ]);
    rawPrisma.$queryRaw
      .mockResolvedValueOnce([{ direction: 'CREDIT', total: 15_000n }, { direction: 'DEBIT', total: 5_000n }]) // acct-1: 10,000
      .mockResolvedValueOnce([]); // acct-2: no entries -> 0

    const report = await service.reconcileOrganization(ORG_ID, ACTOR_ID);

    expect(report.accountsChecked).toBe(2);
    expect(report.accountsWithDrift).toBe(0);
    expect(report.results.every((r) => r.inSync)).toBe(true);
    expect(auditService.record).toHaveBeenCalledTimes(1); // only the summary event
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'reconciliation.completed', metadata: { accountsChecked: 2, accountsWithDrift: 0 } }),
    );
  });

  it('flags a drifted account, records its true computed balance without touching the cache, and audits it', async () => {
    const { service, scopedClient, rawPrisma, auditService } = makeService();
    scopedClient.account.findMany.mockResolvedValue([
      { id: 'acct-1', accountNumber: 'ACC-1', balanceMinorUnits: 10_000n }, // cache says 10,000...
    ]);
    rawPrisma.$queryRaw.mockResolvedValueOnce([{ direction: 'CREDIT', total: 12_000n }]); // ...but the ledger says 12,000

    const report = await service.reconcileOrganization(ORG_ID, ACTOR_ID);

    expect(report.accountsWithDrift).toBe(1);
    expect(report.results[0]).toMatchObject({
      cachedBalanceMinorUnits: '10000',
      computedBalanceMinorUnits: '12000',
      driftMinorUnits: '2000',
      inSync: false,
    });
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'reconciliation.drift_detected',
        resourceId: 'acct-1',
        metadata: { driftMinorUnits: '2000' },
      }),
    );
    // Summary event still fires, as the second (and last) call.
    expect(auditService.record).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'reconciliation.completed', metadata: { accountsChecked: 1, accountsWithDrift: 1 } }),
    );
  });

  it('treats an account with no ledger entries at all as computed balance zero', async () => {
    const { service, scopedClient, rawPrisma } = makeService();
    scopedClient.account.findMany.mockResolvedValue([
      { id: 'acct-new', accountNumber: 'ACC-NEW', balanceMinorUnits: 0n },
    ]);
    rawPrisma.$queryRaw.mockResolvedValueOnce([]);

    const report = await service.reconcileOrganization(ORG_ID);

    expect(report.results[0].inSync).toBe(true);
    expect(report.results[0].computedBalanceMinorUnits).toBe('0');
  });

  it('reconcileAllOrganizations runs reconciliation across every organization', async () => {
    const { service, scopedClient, rawPrisma } = makeService();
    rawPrisma.organization.findMany.mockResolvedValue([{ id: 'org-a' }, { id: 'org-b' }]);
    scopedClient.account.findMany.mockResolvedValue([]); // no accounts in either org, for simplicity
    rawPrisma.$queryRaw.mockResolvedValue([]);

    const reports = await service.reconcileAllOrganizations();

    expect(reports).toHaveLength(2);
    expect(reports.map((r) => r.organizationId)).toEqual(['org-a', 'org-b']);
  });
});
