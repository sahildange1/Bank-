import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { TenantPrismaService } from '../../../common/prisma/tenant-prisma.service';
import { AuditService } from '../../audit/services/audit.service';
import { LedgerService } from './ledger.service';
import { ReconciliationService } from './reconciliation.service';

/**
 * Same limitation as the other *.integration.spec.ts files (binaries.
 * prisma.sh blocked — see Phase 3/4/6/7/8/9 notes). Covers what only a
 * real database proves: that a healthy account posted to exclusively
 * through LedgerService never drifts, and that a cache value changed
 * *outside* LedgerService (simulating exactly the class of bug the
 * reconciliation job exists to catch) is detected without being
 * silently "fixed".
 *
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/corporate_banking \
 *   npx jest --config jest.integration.config.js reconciliation.service.integration
 */
describe('ReconciliationService (integration)', () => {
  let prisma: PrismaClient;
  let ledgerService: LedgerService;
  let reconciliationService: ReconciliationService;
  let orgId: string;
  let actorId: string;
  let sourceAccountId: string;
  let destinationAccountId: string;
  let capitalAccountId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [PrismaService, TenantPrismaService, AuditService, LedgerService, ReconciliationService],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    ledgerService = moduleRef.get(LedgerService);
    reconciliationService = moduleRef.get(ReconciliationService);

    const org = await prisma.organization.create({ data: { legalName: 'Reconciliation Test Co', status: 'ACTIVE' } });
    orgId = org.id;
    const user = await prisma.user.create({
      data: { organizationId: orgId, email: 'actor@reconciletest.test', passwordHash: 'x', status: 'ACTIVE' },
    });
    actorId = user.id;

    // All three accounts start at the schema default (0) — same as a real
    // AccountsService.createAccount() call, which never sets an initial
    // balance. Unlike every other integration fixture in this repo (which
    // shortcuts by seeding a nonzero balanceMinorUnits with no matching
    // ledger entry, fine for THEIR purposes but fatal to this test's — it
    // would make reconciliation "detect drift" on a fixture artifact, not
    // a real bug), the source account's opening balance here is itself
    // posted through the ledger: a capital/equity account absorbs the
    // offsetting debit, the same way a real deployment would model initial
    // capitalization. That keeps every account's cache genuinely
    // ledger-consistent before either test runs.
    const [source, destination, capital] = await Promise.all([
      prisma.account.create({ data: { organizationId: orgId, accountNumber: 'RECON-ACCT-1', currency: 'USD', balanceMinorUnits: 0n } }),
      prisma.account.create({ data: { organizationId: orgId, accountNumber: 'RECON-ACCT-2', currency: 'USD', balanceMinorUnits: 0n } }),
      prisma.account.create({ data: { organizationId: orgId, accountNumber: 'RECON-CAPITAL', currency: 'USD', balanceMinorUnits: 0n } }),
    ]);
    sourceAccountId = source.id;
    destinationAccountId = destination.id;
    capitalAccountId = capital.id;

    // Direct fixture seeding (not via LedgerService — there's no
    // "deposit"/capitalization feature in the app yet, a gap flagged
    // below), but still a real, balanced LedgerEntryGroup with the cache
    // updated to match, exactly like LedgerService itself would do.
    await prisma.$transaction(async (tx: any) => {
      await tx.ledgerEntryGroup.create({
        data: {
          organizationId: orgId,
          idempotencyKey: `recon-opening-capitalization-${Date.now()}`,
          description: 'Opening capitalization (test fixture)',
          entries: {
            create: [
              { accountId: sourceAccountId, direction: 'CREDIT', amountMinorUnits: 100_000n, currency: 'USD' },
              { accountId: capitalAccountId, direction: 'DEBIT', amountMinorUnits: 100_000n, currency: 'USD' },
            ],
          },
        },
      });
      await tx.account.update({ where: { id: sourceAccountId }, data: { balanceMinorUnits: { increment: 100_000n } } });
      await tx.account.update({ where: { id: capitalAccountId }, data: { balanceMinorUnits: { decrement: 100_000n } } });
    });
  });

  afterAll(async () => {
    await prisma.ledgerEntry.deleteMany({});
    await prisma.ledgerEntryGroup.deleteMany({ where: { organizationId: orgId } });
    await prisma.account.deleteMany({ where: { organizationId: orgId } });
    await prisma.user.deleteMany({ where: { organizationId: orgId } });
    await prisma.organization.delete({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  it('finds no drift for an account only ever touched through LedgerService', async () => {
    await ledgerService.postDoubleEntry({
      organizationId: orgId,
      actorUserId: actorId,
      description: 'Reconciliation smoke transfer',
      idempotencyKey: `recon-idem-${Date.now()}`,
      entries: [
        { accountId: sourceAccountId, direction: 'DEBIT', amountMinorUnits: 25_000n, currency: 'USD' },
        { accountId: destinationAccountId, direction: 'CREDIT', amountMinorUnits: 25_000n, currency: 'USD' },
      ],
    });

    const report = await reconciliationService.reconcileOrganization(orgId, actorId);

    expect(report.accountsWithDrift).toBe(0);
    expect(report.results.every((r) => r.inSync)).toBe(true);
  });

  it('detects drift when a cached balance is changed outside LedgerService, without correcting it', async () => {
    // Simulates exactly the bug class this job exists for: some code path
    // writes Account.balanceMinorUnits directly instead of going through
    // LedgerService. Done here with a raw update specifically BECAUSE
    // that's the one thing the real application code is never supposed
    // to do.
    await prisma.account.update({ where: { id: sourceAccountId }, data: { balanceMinorUnits: { decrement: 999n } } });

    const report = await reconciliationService.reconcileOrganization(orgId, actorId);
    const drifted = report.results.find((r) => r.accountId === sourceAccountId);

    expect(drifted?.inSync).toBe(false);
    expect(drifted?.driftMinorUnits).toBe('999');

    // Never auto-corrected: the cache still reflects the bad write.
    const reloaded = await prisma.account.findUnique({ where: { id: sourceAccountId } });
    expect(reloaded?.balanceMinorUnits).toEqual(BigInt(75_000 - 999));

    const driftEvent = await prisma.auditEvent.findFirst({
      where: { action: 'reconciliation.drift_detected', resourceId: sourceAccountId },
      orderBy: { createdAt: 'desc' },
    });
    expect(driftEvent).not.toBeNull();
  });
});
