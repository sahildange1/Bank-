import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantPrismaService } from '../../common/prisma/tenant-prisma.service';
import { AuditService } from '../audit/services/audit.service';
import { LedgerService } from './services/ledger.service';

/**
 * Race-condition tests that only a real database can prove (CI runs them
 * against Postgres; the sandbox cannot generate a Prisma client). They fire
 * truly concurrent postings at the one balance-affecting code path and assert
 * the invariants the SELECT ... FOR UPDATE locking is there to protect.
 */
describe('LedgerService concurrency (integration)', () => {
  let prisma: PrismaClient;
  let ledger: LedgerService;
  let orgId: string;
  let actorId: string;
  let sourceId: string;
  let sinkId: string;
  const run = `${Date.now()}`;

  const post = (key: string, amount: bigint) =>
    ledger.postDoubleEntry({
      organizationId: orgId,
      actorUserId: actorId,
      description: 'concurrency test',
      idempotencyKey: key,
      entries: [
        { accountId: sourceId, direction: 'DEBIT', amountMinorUnits: amount, currency: 'USD' },
        { accountId: sinkId, direction: 'CREDIT', amountMinorUnits: amount, currency: 'USD' },
      ],
    });

  const balance = async (id: string) => (await prisma.account.findUniqueOrThrow({ where: { id } })).balanceMinorUnits;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [PrismaService, TenantPrismaService, AuditService, LedgerService],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    ledger = moduleRef.get(LedgerService);

    const org = await prisma.organization.create({ data: { legalName: 'Concurrency Co', status: 'ACTIVE' } });
    orgId = org.id;
    const user = await prisma.user.create({
      data: { organizationId: orgId, email: `conc-${run}@test.test`, passwordHash: 'x', status: 'ACTIVE' },
    });
    actorId = user.id;
    sourceId = (
      await prisma.account.create({
        data: { organizationId: orgId, accountNumber: `CONC-SRC-${run}`, currency: 'USD', balanceMinorUnits: 1_000n },
      })
    ).id;
    sinkId = (
      await prisma.account.create({
        data: { organizationId: orgId, accountNumber: `CONC-DST-${run}`, currency: 'USD', balanceMinorUnits: 0n },
      })
    ).id;
  });

  afterAll(async () => {
    await prisma.ledgerEntry.deleteMany({ where: { group: { organizationId: orgId } } });
    await prisma.ledgerEntryGroup.deleteMany({ where: { organizationId: orgId } });
    await prisma.account.deleteMany({ where: { organizationId: orgId } });
    await prisma.user.deleteMany({ where: { organizationId: orgId } });
    await prisma.organization.delete({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  it('concurrent debits can never overdraw: exactly floor(balance/amount) succeed and balance stays >= 0', async () => {
    // 1,000 available, 20 concurrent debits of 100 -> exactly 10 may succeed.
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => post(`over-${run}-${i}`, 100n)));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const rejected = results.filter((r) => r.status === 'rejected').length;

    expect(ok).toBe(10);
    expect(rejected).toBe(10);
    expect(await balance(sourceId)).toBe(0n);
    expect(await balance(sinkId)).toBe(1_000n);
  });

  it('the same idempotency key submitted concurrently is applied exactly once', async () => {
    // Source was drained by the previous test; refill it directly (test setup only).
    await prisma.account.update({ where: { id: sourceId }, data: { balanceMinorUnits: 500n } });
    const before = await balance(sourceId);
    const key = `idem-${run}`;

    const results = await Promise.allSettled(Array.from({ length: 8 }, () => post(key, 100n)));

    // Whatever the interleaving, money moved once and only one group exists.
    const groups = await prisma.ledgerEntryGroup.count({ where: { idempotencyKey: key } });
    expect(groups).toBe(1);
    expect(await balance(sourceId)).toBe(before - 100n);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
  });
});
