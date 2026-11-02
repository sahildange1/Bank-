import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantPrismaService } from '../../common/prisma/tenant-prisma.service';
import { AuditService } from '../audit/services/audit.service';
import { BeneficiariesService } from '../beneficiaries/beneficiaries.service';
import { PaymentStateMachine } from './services/payment-state-machine';
import { PaymentsService } from './payments.service';

/**
 * Same limitation as the other *.integration.spec.ts files in this repo
 * (binaries.prisma.sh is blocked — see Phase 3/4/6/7 notes). The core
 * business rules (idempotency, currency validation, beneficiary
 * eligibility gating, policy resolution) are already covered for real by
 * payments.service.spec.ts (mocked Prisma). This file additionally
 * exercises what only a real database proves: FK integrity on
 * approvalPolicyId and the full create -> submit -> cancel lifecycle
 * end-to-end, including the actual cooling-off timing from Phase 7.
 *
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/corporate_banking \
 *   npx jest --config jest.integration.config.js payments.integration
 */
describe('PaymentsService (integration)', () => {
  let prisma: PrismaClient;
  let service: PaymentsService;
  let orgId: string;
  let makerId: string;
  let approverId: string;
  let accountId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        PrismaService,
        TenantPrismaService,
        AuditService,
        BeneficiariesService,
        PaymentStateMachine,
        PaymentsService,
      ],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    service = moduleRef.get(PaymentsService);

    const org = await prisma.organization.create({ data: { legalName: 'Payments Test Co', status: 'ACTIVE' } });
    orgId = org.id;
    const maker = await prisma.user.create({
      data: { organizationId: orgId, email: 'maker@paytest.test', passwordHash: 'x', status: 'ACTIVE' },
    });
    const approver = await prisma.user.create({
      data: { organizationId: orgId, email: 'approver@paytest.test', passwordHash: 'x', status: 'ACTIVE' },
    });
    makerId = maker.id;
    approverId = approver.id;

    const account = await prisma.account.create({
      data: { organizationId: orgId, accountNumber: 'PAY-ACCT-1', currency: 'USD', balanceMinorUnits: 1_000_000n },
    });
    accountId = account.id;

    await prisma.approvalPolicy.create({
      data: {
        organizationId: orgId,
        name: 'Standard',
        minAmountMinorUnits: 0n,
        maxAmountMinorUnits: null,
        requiredApprovals: 1,
        makerCanApproveOwn: false,
      },
    });
  });

  afterAll(async () => {
    await prisma.paymentStateTransition.deleteMany({});
    await prisma.payment.deleteMany({ where: { organizationId: orgId } });
    await prisma.approvalPolicy.deleteMany({ where: { organizationId: orgId } });
    await prisma.beneficiary.deleteMany({ where: { organizationId: orgId } });
    await prisma.account.deleteMany({ where: { organizationId: orgId } });
    await prisma.user.deleteMany({ where: { organizationId: orgId } });
    await prisma.organization.delete({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  it('full lifecycle: create (DRAFT, beneficiary still cooling off) -> blocked submit -> eligible after cooling-off -> submit succeeds -> cancel is rejected after PENDING_APPROVAL only for terminal states', async () => {
    const beneficiary = await prisma.beneficiary.create({
      data: {
        organizationId: orgId,
        name: 'Fresh Supplier',
        accountNumber: '5555555555',
        verificationStatus: 'VERIFIED',
        verifiedAt: new Date(), // just verified -- still cooling off
        verifiedByUserId: approverId,
        createdByUserId: makerId,
      },
    });

    const payment = await service.createPayment(orgId, makerId, {
      sourceAccountId: accountId,
      beneficiaryId: beneficiary.id,
      amountMinorUnits: '15000',
      currency: 'USD',
      idempotencyKey: `idem-${Date.now()}`,
    } as any);
    expect(payment.status).toEqual('DRAFT');

    // Still cooling off -- submit must be rejected.
    await expect(service.submitPayment(orgId, makerId, payment.id)).rejects.toThrow();

    // Back-date verifiedAt past the cooling-off window and retry.
    await prisma.beneficiary.update({
      where: { id: beneficiary.id },
      data: { verifiedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    });

    const submitted = await service.submitPayment(orgId, makerId, payment.id);
    expect(submitted.status).toEqual('PENDING_APPROVAL');
    expect(submitted.approvalPolicyId).toBeTruthy();

    // FK integrity: approvalPolicyId actually points at a real ApprovalPolicy row.
    const policy = await prisma.approvalPolicy.findUnique({ where: { id: submitted.approvalPolicyId! } });
    expect(policy).not.toBeNull();

    const history = await service.getPaymentHistory(orgId, payment.id);
    expect(history.map((h: { toState: string }) => h.toState)).toEqual(['PENDING_APPROVAL']);

    // PENDING_APPROVAL -> CANCELLED is legal.
    const cancelled = await service.cancelPayment(orgId, makerId, payment.id, 'no longer needed');
    expect(cancelled.status).toEqual('CANCELLED');

    // CANCELLED is terminal -- cancelling again must fail.
    await expect(service.cancelPayment(orgId, makerId, payment.id)).rejects.toThrow();
  });

  it('idempotent creation: calling createPayment twice with the same key returns the same payment, not a duplicate', async () => {
    const beneficiary = await prisma.beneficiary.create({
      data: {
        organizationId: orgId,
        name: 'Idempotency Supplier',
        accountNumber: '6666666666',
        active: true,
      },
    });
    const key = `idem-fixed-${Date.now()}`;

    const first = await service.createPayment(orgId, makerId, {
      sourceAccountId: accountId,
      beneficiaryId: beneficiary.id,
      amountMinorUnits: '100',
      currency: 'USD',
      idempotencyKey: key,
    } as any);
    const second = await service.createPayment(orgId, makerId, {
      sourceAccountId: accountId,
      beneficiaryId: beneficiary.id,
      amountMinorUnits: '999999', // even with different params, the key wins
      currency: 'USD',
      idempotencyKey: key,
    } as any);

    expect(second.id).toEqual(first.id);
    const count = await prisma.payment.count({ where: { idempotencyKey: key } });
    expect(count).toEqual(1);
  });
});
