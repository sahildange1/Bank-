import { LedgerService } from './ledger.service';

/**
 * LedgerService.postDoubleEntry() itself has no mocked-Prisma unit spec —
 * see ledger.service.integration.spec.ts's own note: its core logic (row
 * locking via raw `FOR UPDATE` SQL, a multi-statement `$transaction`) is
 * meaningfully exercised only against a real database, and was verified
 * there during Phase 6. getOrCreateSettlementAccount() (Phase 10) is
 * different: it's plain find-then-create logic over two model calls, the
 * same shape as the account-number generation in AccountsService, so a
 * mocked-Prisma unit test is worth having for it specifically.
 */
describe('LedgerService.getOrCreateSettlementAccount (unit, mocked Prisma)', () => {
  function makeService() {
    const prisma = {
      account: { findFirst: jest.fn(), create: jest.fn() },
    };
    const service = new LedgerService(prisma as any, {} as any);
    return { service, prisma };
  }

  it('returns the existing SETTLEMENT account for this org+currency without creating a new one', async () => {
    const { service, prisma } = makeService();
    prisma.account.findFirst.mockResolvedValue({ id: 'settlement-1', purpose: 'SETTLEMENT' });

    const result = await service.getOrCreateSettlementAccount('org-1', 'USD');

    expect(result).toEqual({ id: 'settlement-1', purpose: 'SETTLEMENT' });
    expect(prisma.account.create).not.toHaveBeenCalled();
  });

  it('creates a new SETTLEMENT account when none exists yet', async () => {
    const { service, prisma } = makeService();
    prisma.account.findFirst.mockResolvedValue(null);
    prisma.account.create.mockResolvedValue({ id: 'settlement-new', purpose: 'SETTLEMENT', currency: 'USD' });

    const result = await service.getOrCreateSettlementAccount('org-1', 'USD');

    expect(result).toEqual({ id: 'settlement-new', purpose: 'SETTLEMENT', currency: 'USD' });
    expect(prisma.account.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ organizationId: 'org-1', currency: 'USD', purpose: 'SETTLEMENT', status: 'ACTIVE' }),
      }),
    );
  });

  it('falls back to the concurrent winner’s row when create() loses the race to the DB unique index', async () => {
    const { service, prisma } = makeService();
    prisma.account.findFirst
      .mockResolvedValueOnce(null) // initial check: none exists yet
      .mockResolvedValueOnce({ id: 'settlement-winner', purpose: 'SETTLEMENT' }); // after the failed create: the other caller's row
    prisma.account.create.mockRejectedValue(new Error('duplicate key value violates unique constraint'));

    const result = await service.getOrCreateSettlementAccount('org-1', 'USD');

    expect(result).toEqual({ id: 'settlement-winner', purpose: 'SETTLEMENT' });
  });
});
