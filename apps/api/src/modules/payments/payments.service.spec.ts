import { BadRequestException, UnprocessableEntityException } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PaymentStateMachine } from './services/payment-state-machine';

/**
 * Same approach as beneficiaries.service.spec.ts (Phase 7): mocked
 * TenantPrismaService/PrismaService/AuditService/BeneficiariesService, so
 * this runs for real in this sandbox despite the binaries.prisma.sh block.
 * Covers the business rules that are PaymentsService's own responsibility
 * — idempotency, currency/status validation, the beneficiary-eligibility
 * gate at submit() time, and approval-policy resolution — using the real
 * (non-mocked) PaymentStateMachine so the transition table is exercised
 * for real too.
 */
describe('PaymentsService (unit, mocked Prisma)', () => {
  const ORG_ID = 'org-1';
  const ACTOR_ID = 'user-1';

  function makeService() {
    const scopedClient = {
      payment: { create: jest.fn(), findMany: jest.fn(), findUnique: jest.fn() },
      account: { findUnique: jest.fn() },
      beneficiary: { findUnique: jest.fn() },
      approvalPolicy: { findMany: jest.fn() },
    };
    const tx = {
      payment: { update: jest.fn() },
      paymentStateTransition: { create: jest.fn() },
    };
    const rawPrisma = {
      payment: { findUnique: jest.fn() },
      paymentStateTransition: { findMany: jest.fn() },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const tenantPrisma = { forOrg: jest.fn().mockReturnValue(scopedClient) };
    const auditService = { record: jest.fn().mockResolvedValue(undefined) };
    const beneficiariesService = { isEligibleForPayments: jest.fn() };
    const stateMachine = new PaymentStateMachine();

    const service = new PaymentsService(
      rawPrisma as any,
      tenantPrisma as any,
      auditService as any,
      beneficiariesService as any,
      stateMachine,
    );
    return { service, scopedClient, rawPrisma, tx, auditService, beneficiariesService };
  }

  describe('createPayment', () => {
    it('returns the existing payment when the idempotency key was already used (same org)', async () => {
      const { service, rawPrisma } = makeService();
      rawPrisma.payment.findUnique.mockResolvedValue({ id: 'pay-1', organizationId: ORG_ID });

      const result = await service.createPayment(ORG_ID, ACTOR_ID, {
        sourceAccountId: 'acct-1',
        beneficiaryId: 'ben-1',
        amountMinorUnits: '5000',
        currency: 'USD',
        idempotencyKey: 'idem-1',
      } as any);

      expect(result).toEqual({ id: 'pay-1', organizationId: ORG_ID });
    });

    it('refuses to reuse an idempotency key that belongs to a different organization', async () => {
      const { service, rawPrisma } = makeService();
      rawPrisma.payment.findUnique.mockResolvedValue({ id: 'pay-1', organizationId: 'some-other-org' });

      await expect(
        service.createPayment(ORG_ID, ACTOR_ID, {
          sourceAccountId: 'acct-1',
          beneficiaryId: 'ben-1',
          amountMinorUnits: '5000',
          currency: 'USD',
          idempotencyKey: 'idem-1',
        } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a currency mismatch between the payment and the source account', async () => {
      const { service, rawPrisma, scopedClient } = makeService();
      rawPrisma.payment.findUnique.mockResolvedValue(null);
      scopedClient.account.findUnique.mockResolvedValue({ id: 'acct-1', currency: 'EUR', status: 'ACTIVE' });
      scopedClient.beneficiary.findUnique.mockResolvedValue({ id: 'ben-1', active: true });

      await expect(
        service.createPayment(ORG_ID, ACTOR_ID, {
          sourceAccountId: 'acct-1',
          beneficiaryId: 'ben-1',
          amountMinorUnits: '5000',
          currency: 'USD', // mismatch
          idempotencyKey: 'idem-2',
        } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a payment to a disabled beneficiary', async () => {
      const { service, rawPrisma, scopedClient } = makeService();
      rawPrisma.payment.findUnique.mockResolvedValue(null);
      scopedClient.account.findUnique.mockResolvedValue({ id: 'acct-1', currency: 'USD', status: 'ACTIVE' });
      scopedClient.beneficiary.findUnique.mockResolvedValue({ id: 'ben-1', active: false });

      await expect(
        service.createPayment(ORG_ID, ACTOR_ID, {
          sourceAccountId: 'acct-1',
          beneficiaryId: 'ben-1',
          amountMinorUnits: '5000',
          currency: 'USD',
          idempotencyKey: 'idem-3',
        } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('does NOT require beneficiary eligibility (cooling-off) at DRAFT creation time', async () => {
      const { service, rawPrisma, scopedClient, beneficiariesService } = makeService();
      rawPrisma.payment.findUnique.mockResolvedValue(null);
      scopedClient.account.findUnique.mockResolvedValue({ id: 'acct-1', currency: 'USD', status: 'ACTIVE' });
      scopedClient.beneficiary.findUnique.mockResolvedValue({ id: 'ben-1', active: true }); // not verified, still fine
      scopedClient.payment.create.mockResolvedValue({ id: 'pay-new', status: 'DRAFT' });

      const result = await service.createPayment(ORG_ID, ACTOR_ID, {
        sourceAccountId: 'acct-1',
        beneficiaryId: 'ben-1',
        amountMinorUnits: '5000',
        currency: 'USD',
        idempotencyKey: 'idem-4',
      } as any);

      expect(result).toEqual({ id: 'pay-new', status: 'DRAFT' });
      expect(beneficiariesService.isEligibleForPayments).not.toHaveBeenCalled();
    });
  });

  describe('submitPayment', () => {
    it('rejects submitting a payment that is not in DRAFT (invalid transition)', async () => {
      const { service, scopedClient } = makeService();
      scopedClient.payment.findUnique.mockResolvedValue({
        id: 'pay-1',
        status: 'CANCELLED', // terminal — CANCELLED -> PENDING_APPROVAL is illegal
        sourceAccountId: 'acct-1',
        beneficiaryId: 'ben-1',
        amountMinorUnits: 5000n,
        currency: 'USD',
      });

      await expect(service.submitPayment(ORG_ID, ACTOR_ID, 'pay-1')).rejects.toThrow();
    });

    it('rejects submission when the beneficiary is not yet eligible (cooling-off / unverified)', async () => {
      const { service, scopedClient, beneficiariesService } = makeService();
      scopedClient.payment.findUnique.mockResolvedValue({
        id: 'pay-1',
        status: 'DRAFT',
        sourceAccountId: 'acct-1',
        beneficiaryId: 'ben-1',
        amountMinorUnits: 5000n,
        currency: 'USD',
      });
      scopedClient.account.findUnique.mockResolvedValue({ id: 'acct-1', status: 'ACTIVE' });
      scopedClient.beneficiary.findUnique.mockResolvedValue({ id: 'ben-1', active: true, verificationStatus: 'PENDING' });
      beneficiariesService.isEligibleForPayments.mockReturnValue(false);

      await expect(service.submitPayment(ORG_ID, ACTOR_ID, 'pay-1')).rejects.toThrow(UnprocessableEntityException);
    });

    it('rejects submission when no ApprovalPolicy covers the payment amount', async () => {
      const { service, scopedClient, beneficiariesService } = makeService();
      scopedClient.payment.findUnique.mockResolvedValue({
        id: 'pay-1',
        status: 'DRAFT',
        sourceAccountId: 'acct-1',
        beneficiaryId: 'ben-1',
        amountMinorUnits: 5000n,
        currency: 'USD',
      });
      scopedClient.account.findUnique.mockResolvedValue({ id: 'acct-1', status: 'ACTIVE' });
      scopedClient.beneficiary.findUnique.mockResolvedValue({ id: 'ben-1', active: true });
      beneficiariesService.isEligibleForPayments.mockReturnValue(true);
      scopedClient.approvalPolicy.findMany.mockResolvedValue([]); // no policy covers this amount

      await expect(service.submitPayment(ORG_ID, ACTOR_ID, 'pay-1')).rejects.toThrow(UnprocessableEntityException);
    });

    it('submits successfully: resolves a policy, transitions to PENDING_APPROVAL, records the transition and audit event', async () => {
      const { service, scopedClient, tx, auditService, beneficiariesService } = makeService();
      scopedClient.payment.findUnique.mockResolvedValue({
        id: 'pay-1',
        status: 'DRAFT',
        sourceAccountId: 'acct-1',
        beneficiaryId: 'ben-1',
        amountMinorUnits: 5000n,
        currency: 'USD',
      });
      scopedClient.account.findUnique.mockResolvedValue({ id: 'acct-1', status: 'ACTIVE' });
      scopedClient.beneficiary.findUnique.mockResolvedValue({ id: 'ben-1', active: true });
      beneficiariesService.isEligibleForPayments.mockReturnValue(true);
      scopedClient.approvalPolicy.findMany.mockResolvedValue([{ id: 'policy-1', minAmountMinorUnits: 0n }]);
      tx.payment.update.mockResolvedValue({ id: 'pay-1', status: 'PENDING_APPROVAL', approvalPolicyId: 'policy-1' });

      const result = await service.submitPayment(ORG_ID, ACTOR_ID, 'pay-1');

      expect(result.status).toEqual('PENDING_APPROVAL');
      expect(tx.payment.update).toHaveBeenCalledWith({
        where: { id: 'pay-1' },
        data: { status: 'PENDING_APPROVAL', approvalPolicyId: 'policy-1' },
      });
      expect(tx.paymentStateTransition.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ fromState: 'DRAFT', toState: 'PENDING_APPROVAL', actorUserId: ACTOR_ID }),
        }),
      );
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'payment.submitted' }),
        tx,
      );
    });
  });

  describe('cancelPayment', () => {
    it('allows cancelling a DRAFT payment', async () => {
      const { service, scopedClient, tx } = makeService();
      scopedClient.payment.findUnique.mockResolvedValue({ id: 'pay-1', status: 'DRAFT' });
      tx.payment.update.mockResolvedValue({ id: 'pay-1', status: 'CANCELLED' });

      const result = await service.cancelPayment(ORG_ID, ACTOR_ID, 'pay-1', 'changed my mind');
      expect(result.status).toEqual('CANCELLED');
    });

    it('allows cancelling a PENDING_APPROVAL payment', async () => {
      const { service, scopedClient, tx } = makeService();
      scopedClient.payment.findUnique.mockResolvedValue({ id: 'pay-1', status: 'PENDING_APPROVAL' });
      tx.payment.update.mockResolvedValue({ id: 'pay-1', status: 'CANCELLED' });

      await expect(service.cancelPayment(ORG_ID, ACTOR_ID, 'pay-1')).resolves.toBeDefined();
    });

    it('rejects cancelling an already-COMPLETED payment (terminal state)', async () => {
      const { service, scopedClient } = makeService();
      scopedClient.payment.findUnique.mockResolvedValue({ id: 'pay-1', status: 'COMPLETED' });

      await expect(service.cancelPayment(ORG_ID, ACTOR_ID, 'pay-1')).rejects.toThrow();
    });
  });
});
