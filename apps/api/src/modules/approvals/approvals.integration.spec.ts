import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantPrismaService } from '../../common/prisma/tenant-prisma.service';
import { AuditService } from '../audit/services/audit.service';
import { PaymentStateMachine } from '../payments/services/payment-state-machine';
import { ApprovalsService } from './approvals.service';

/**
 * Same limitation as the other *.integration.spec.ts files in this repo
 * (binaries.prisma.sh is blocked — see Phase 3/4/6/7/8 notes). The
 * business rules (self-approval blocking, quorum math, duplicate-decision
 * rejection) are already covered for real by approvals.service.spec.ts
 * (mocked Prisma). This file additionally exercises what only a real
 * database proves: the `@@unique([paymentId, approverUserId])` constraint
 * actually rejecting a concurrent double-decision at the DB level (not
 * just the app-level pre-check), and the full N-of-2 approval lifecycle
 * end-to-end against real rows.
 *
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/corporate_banking \
 *   npx jest --config jest.integration.config.js approvals.integration
 */
describe('ApprovalsService (integration)', () => {
  let prisma: PrismaClient;
  let service: ApprovalsService;
  let orgId: string;
  let makerId: string;
  let approverOneId: string;
  let approverTwoId: string;
  let accountId: string;
  let twoOfTwoPolicyId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [PrismaService, TenantPrismaService, AuditService, PaymentStateMachine, ApprovalsService],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    service = moduleRef.get(ApprovalsService);

    const org = await prisma.organization.create({ data: { legalName: 'Approvals Test Co', status: 'ACTIVE' } });
    orgId = org.id;

    const [maker, approverOne, approverTwo] = await Promise.all([
      prisma.user.create({ data: { organizationId: orgId, email: 'maker@approvetest.test', passwordHash: 'x', status: 'ACTIVE' } }),
      prisma.user.create({ data: { organizationId: orgId, email: 'approver1@approvetest.test', passwordHash: 'x', status: 'ACTIVE' } }),
      prisma.user.create({ data: { organizationId: orgId, email: 'approver2@approvetest.test', passwordHash: 'x', status: 'ACTIVE' } }),
    ]);
    makerId = maker.id;
    approverOneId = approverOne.id;
    approverTwoId = approverTwo.id;

    const account = await prisma.account.create({
      data: { organizationId: orgId, accountNumber: 'APPROVE-ACCT-1', currency: 'USD', balanceMinorUnits: 1_000_000n },
    });
    accountId = account.id;

    const policy = await prisma.approvalPolicy.create({
      data: {
        organizationId: orgId,
        name: 'Two-of-two (high value)',
        minAmountMinorUnits: 0n,
        maxAmountMinorUnits: null,
        requiredApprovals: 2,
        makerCanApproveOwn: false,
      },
    });
    twoOfTwoPolicyId = policy.id;
  });

  afterAll(async () => {
    await prisma.paymentApproval.deleteMany({});
    await prisma.paymentStateTransition.deleteMany({});
    await prisma.payment.deleteMany({ where: { organizationId: orgId } });
    await prisma.approvalPolicy.deleteMany({ where: { organizationId: orgId } });
    await prisma.account.deleteMany({ where: { organizationId: orgId } });
    await prisma.user.deleteMany({ where: { organizationId: orgId } });
    await prisma.organization.delete({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  async function createPendingPayment(idemSuffix: string) {
    const beneficiary = await prisma.beneficiary.create({
      data: {
        organizationId: orgId,
        name: `Supplier ${idemSuffix}`,
        accountNumber: `9${idemSuffix.padStart(9, '0')}`,
        verificationStatus: 'VERIFIED',
        verifiedAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // past cooling-off
        verifiedByUserId: approverOneId,
        createdByUserId: makerId,
      },
    });
    const payment = await prisma.payment.create({
      data: {
        organizationId: orgId,
        sourceAccountId: accountId,
        beneficiaryId: beneficiary.id,
        createdByUserId: makerId,
        approvalPolicyId: twoOfTwoPolicyId,
        idempotencyKey: `idem-approve-${idemSuffix}-${Date.now()}`,
        amountMinorUnits: 25_000n,
        currency: 'USD',
        status: 'PENDING_APPROVAL',
      },
    });
    return payment;
  }

  it('full N-of-2 lifecycle: first approval records progress, second finalizes to APPROVED', async () => {
    const payment = await createPendingPayment('1');

    const first = await service.approvePayment(orgId, approverOneId, payment.id);
    expect(first.finalized).toBe(false);
    expect(first.approvedCount).toEqual(1);

    const reloadedAfterFirst = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(reloadedAfterFirst?.status).toEqual('PENDING_APPROVAL');

    const second = await service.approvePayment(orgId, approverTwoId, payment.id);
    expect(second.finalized).toBe(true);

    const reloadedAfterSecond = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(reloadedAfterSecond?.status).toEqual('APPROVED');

    const transitions = await prisma.paymentStateTransition.findMany({ where: { paymentId: payment.id } });
    expect(transitions.map((t: { toState: string }) => t.toState)).toEqual(['APPROVED']);
  });

  it('rejects a duplicate decision from the same approver even when the app-level pre-check is bypassed (DB unique constraint)', async () => {
    const payment = await createPendingPayment('2');
    await service.approvePayment(orgId, approverOneId, payment.id);

    // Simulate a race where two requests from the same approver both pass
    // the app-level findUnique pre-check before either writes — go
    // straight at the table the way a racing second request effectively
    // would, and confirm the schema's @@unique([paymentId, approverUserId])
    // constraint is what actually stops it, not just the service's check.
    await expect(
      prisma.paymentApproval.create({
        data: { paymentId: payment.id, approverUserId: approverOneId, decision: 'APPROVED' },
      }),
    ).rejects.toThrow();
  });

  it('a single rejection ends the payment immediately, with no quorum required', async () => {
    const payment = await createPendingPayment('3');

    const result = await service.rejectPayment(orgId, approverOneId, payment.id, 'does not look legitimate');
    expect(result.status).toEqual('REJECTED');

    // The other approver can no longer act on it — it's terminal.
    await expect(service.approvePayment(orgId, approverTwoId, payment.id)).rejects.toThrow();
  });

  it('blocks the maker from approving or rejecting their own payment', async () => {
    const payment = await createPendingPayment('4');

    await expect(service.approvePayment(orgId, makerId, payment.id)).rejects.toThrow();
    await expect(service.rejectPayment(orgId, makerId, payment.id, 'self-objection')).rejects.toThrow();
  });
});
