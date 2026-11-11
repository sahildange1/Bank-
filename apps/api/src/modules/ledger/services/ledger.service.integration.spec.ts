import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { TenantPrismaService } from '../../../common/prisma/tenant-prisma.service';
import { AuditService } from '../../audit/services/audit.service';
import { LedgerService } from './ledger.service';

/**
 * Same limitation as the other *.integration.spec.ts files in this repo:
 * requires a real, generated Prisma client (binaries.prisma.sh is blocked
 * in the sandbox this was authored in — see Phase 3/4 notes). The same
 * invariants exercised here (balances update correctly, entries net to
 * zero, idempotency key is enforced, overdraft is rejected) were verified
 * for real against a live Postgres instance using raw SQL during Phase 6 —
 * see the Phase 6 write-up — but that's not a substitute for running this
 * file for real once a client can be generated:
 *
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/corporate_banking \
 *   npx jest --config jest.integration.config.js ledger.service.integration
 */
describe('LedgerService (integration)', () => {
  let prisma: PrismaClient;
  let ledgerService: LedgerService;
  let orgId: string;
  let acctAId: string;
  let acctBId: string;
  let actorId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [PrismaService, TenantPrismaService, AuditService, LedgerService],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    ledgerService = moduleRef.get(LedgerService);

    const org = await prisma.organization.create({ data: { legalName: 'Ledger Test Co', status: 'ACTIVE' } });
    orgId = org.id;
    // audit_events.actorId is a real foreign key to users, so the actor must exist.
    const actor = await prisma.user.create({
      data: { organizationId: orgId, email: `ledger-actor-${Date.now()}@test.local`, passwordHash: 'x', status: 'ACTIVE' },
    });
    actorId = actor.id;
    const acctA = await prisma.account.create({
      data: { organizationId: orgId, accountNumber: 'LEDGER-A', currency: 'USD', balanceMinorUnits: 10_000n },
    });
    const acctB = await prisma.account.create({
      data: { organizationId: orgId, accountNumber: 'LEDGER-B', currency: 'USD', balanceMinorUnits: 0n },
    });
    acctAId = acctA.id;
    acctBId = acctB.id;
  });

  afterAll(async () => {
    await prisma.ledgerEntry.deleteMany({});
    await prisma.ledgerEntryGroup.deleteMany({ where: { organizationId: orgId } });
    await prisma.account.deleteMany({ where: { organizationId: orgId } });
    await prisma.user.deleteMany({ where: { organizationId: orgId } });
    await prisma.organization.delete({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  it('posts a balanced transfer and updates both account balances correctly', async () => {
    const result = await ledgerService.postDoubleEntry({
      organizationId: orgId,
      actorUserId: actorId,
      description: 'Test transfer',
      idempotencyKey: 'test-key-1',
      entries: [
        { accountId: acctAId, direction: 'DEBIT', amountMinorUnits: 3000n, currency: 'USD' },
        { accountId: acctBId, direction: 'CREDIT', amountMinorUnits: 3000n, currency: 'USD' },
      ],
    });
    expect(result.alreadyPosted).toBe(false);

    const [acctA, acctB] = await Promise.all([
      prisma.account.findUnique({ where: { id: acctAId } }),
      prisma.account.findUnique({ where: { id: acctBId } }),
    ]);
    expect(acctA?.balanceMinorUnits).toEqual(7000n);
    expect(acctB?.balanceMinorUnits).toEqual(3000n);

    const entries = await prisma.ledgerEntry.findMany({ where: { groupId: result.groupId } });
    const net = entries.reduce(
      (sum: bigint, e: { direction: string; amountMinorUnits: bigint }) =>
        sum + (e.direction === 'DEBIT' ? e.amountMinorUnits : -e.amountMinorUnits),
      0n,
    );
    expect(net).toEqual(0n);
  });

  it('is idempotent: reposting with the same idempotencyKey returns the existing group without double-applying', async () => {
    const result = await ledgerService.postDoubleEntry({
      organizationId: orgId,
      actorUserId: actorId,
      description: 'Test transfer (repeat)',
      idempotencyKey: 'test-key-1', // same key as the previous test
      entries: [
        { accountId: acctAId, direction: 'DEBIT', amountMinorUnits: 3000n, currency: 'USD' },
        { accountId: acctBId, direction: 'CREDIT', amountMinorUnits: 3000n, currency: 'USD' },
      ],
    });
    expect(result.alreadyPosted).toBe(true);

    // Balances must NOT have moved a second time.
    const acctA = await prisma.account.findUnique({ where: { id: acctAId } });
    expect(acctA?.balanceMinorUnits).toEqual(7000n);
  });

  it('rejects a posting that would overdraw an account', async () => {
    await expect(
      ledgerService.postDoubleEntry({
        organizationId: orgId,
        actorUserId: actorId,
        description: 'Overdraw attempt',
        idempotencyKey: 'test-key-overdraw',
        entries: [
          { accountId: acctAId, direction: 'DEBIT', amountMinorUnits: 999_999n, currency: 'USD' },
          { accountId: acctBId, direction: 'CREDIT', amountMinorUnits: 999_999n, currency: 'USD' },
        ],
      }),
    ).rejects.toThrow();

    const acctA = await prisma.account.findUnique({ where: { id: acctAId } });
    expect(acctA?.balanceMinorUnits).toEqual(7000n); // unchanged
  });

  it('rejects entries that do not net to zero (double-entry invariant)', async () => {
    await expect(
      ledgerService.postDoubleEntry({
        organizationId: orgId,
        actorUserId: actorId,
        description: 'Unbalanced posting',
        idempotencyKey: 'test-key-unbalanced',
        entries: [
          { accountId: acctAId, direction: 'DEBIT', amountMinorUnits: 100n, currency: 'USD' },
          { accountId: acctBId, direction: 'CREDIT', amountMinorUnits: 50n, currency: 'USD' },
        ],
      }),
    ).rejects.toThrow();
  });

  it('rejects a posting that references an account from another organization', async () => {
    const otherOrg = await prisma.organization.create({ data: { legalName: 'Other Org', status: 'ACTIVE' } });
    const otherAcct = await prisma.account.create({
      data: { organizationId: otherOrg.id, accountNumber: 'OTHER-A', currency: 'USD' },
    });

    await expect(
      ledgerService.postDoubleEntry({
        organizationId: orgId, // caller claims to be orgId...
        actorUserId: actorId,
        description: 'Cross-org attempt',
        idempotencyKey: 'test-key-cross-org',
        entries: [
          { accountId: acctAId, direction: 'DEBIT', amountMinorUnits: 100n, currency: 'USD' },
          { accountId: otherAcct.id, direction: 'CREDIT', amountMinorUnits: 100n, currency: 'USD' }, // ...but this account belongs to otherOrg
        ],
      }),
    ).rejects.toThrow();

    await prisma.account.delete({ where: { id: otherAcct.id } });
    await prisma.organization.delete({ where: { id: otherOrg.id } });
  });

  // Phase 10: getOrCreateSettlementAccount().
  it('creates exactly one SETTLEMENT account per (organization, currency), reusing it on repeat calls', async () => {
    const first = await ledgerService.getOrCreateSettlementAccount(orgId, 'USD');
    expect(first.purpose).toEqual('SETTLEMENT');
    expect(first.organizationId).toEqual(orgId);

    const second = await ledgerService.getOrCreateSettlementAccount(orgId, 'USD');
    expect(second.id).toEqual(first.id); // same row, not a duplicate

    const count = await prisma.account.count({ where: { organizationId: orgId, currency: 'USD', purpose: 'SETTLEMENT' } });
    expect(count).toEqual(1);

    await prisma.account.delete({ where: { id: first.id } });
  });

  it('can actually be posted to through postDoubleEntry, as the CREDIT side of a payment execution', async () => {
    const settlement = await ledgerService.getOrCreateSettlementAccount(orgId, 'USD');

    const result = await ledgerService.postDoubleEntry({
      organizationId: orgId,
      actorUserId: actorId,
      description: 'Simulated payment execution',
      idempotencyKey: `settlement-smoke-${Date.now()}`,
      entries: [
        { accountId: acctAId, direction: 'DEBIT', amountMinorUnits: 1000n, currency: 'USD' },
        { accountId: settlement.id, direction: 'CREDIT', amountMinorUnits: 1000n, currency: 'USD' },
      ],
    });
    expect(result.alreadyPosted).toBe(false);

    const reloaded = await prisma.account.findUnique({ where: { id: settlement.id } });
    expect(reloaded?.balanceMinorUnits).toEqual(1000n);
    // No per-test delete: ledger entries reference this account, so afterAll
    // (which clears entries first) removes it with the rest of the org's accounts.
  });
});
