import { ConflictException, ForbiddenException } from '@nestjs/common';
import { ApprovalsService } from './approvals.service';
import { PaymentStateMachine } from '../payments/services/payment-state-machine';

/**
 * Same mocked-Prisma approach as payments.service.spec.ts (Phase 8) and
 * beneficiaries.service.spec.ts (Phase 7). Uses the real (non-mocked)
 * PaymentStateMachine so the PENDING_APPROVAL -> APPROVED/REJECTED
 * transitions are exercised for real, not just assumed legal.
 */
describe('ApprovalsService (unit, mocked Prisma)', () => {
  const ORG_ID = 'org-1';
  const MAKER_ID = 'user-maker';
  const APPROVER_ID = 'user-approver';

  function makeService() {
    const scopedClient = {
      payment: { findUnique: jest.fn() },
    };
    const tx = {
      paymentApproval: { create: jest.fn(), count: jest.fn() },
      payment: { update: jest.fn() },
      paymentStateTransition: { create: jest.fn() },
    };
    const rawPrisma = {
      paymentApproval: { findUnique: jest.fn(), findMany: jest.fn() },
      approvalPolicy: { findUnique: jest.fn() },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const tenantPrisma = { forOrg: jest.fn().mockReturnValue(scopedClient) };
    const auditService = { record: jest.fn().mockResolvedValue(undefined) };
    const stateMachine = new PaymentStateMachine();

    const service = new ApprovalsService(rawPrisma as any, tenantPrisma as any, auditService as any, stateMachine);
    return { service, scopedClient, rawPrisma, tx, auditService };
  }

  const PENDING_PAYMENT = {
    id: 'pay-1',
    status: 'PENDING_APPROVAL',
    createdByUserId: MAKER_ID,
    approvalPolicyId: 'policy-1',
  };

  describe('approvePayment', () => {
    it('blocks the payment creator from approving their own payment', async () => {
      const { service, scopedClient, rawPrisma, auditService } = makeService();
      scopedClient.payment.findUnique.mockResolvedValue(PENDING_PAYMENT);
      rawPrisma.approvalPolicy.findUnique.mockResolvedValue({ id: 'policy-1', requiredApprovals: 1, makerCanApproveOwn: false });

      await expect(service.approvePayment(ORG_ID, MAKER_ID, 'pay-1')).rejects.toThrow(ForbiddenException);
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'payment.approve_blocked_self_approval' }),
      );
    });

    it('allows self-approval when the policy explicitly opts in via makerCanApproveOwn', async () => {
      const { service, scopedClient, rawPrisma, tx } = makeService();
      scopedClient.payment.findUnique.mockResolvedValue(PENDING_PAYMENT);
      rawPrisma.approvalPolicy.findUnique.mockResolvedValue({ id: 'policy-1', requiredApprovals: 1, makerCanApproveOwn: true });
      rawPrisma.paymentApproval.findUnique.mockResolvedValue(null);
      tx.paymentApproval.count.mockResolvedValue(1);
      tx.payment.update.mockResolvedValue({ id: 'pay-1', status: 'APPROVED' });

      const result = await service.approvePayment(ORG_ID, MAKER_ID, 'pay-1');
      expect(result.finalized).toBe(true);
    });

    it('rejects a second decision from the same approver on the same payment', async () => {
      const { service, scopedClient, rawPrisma } = makeService();
      scopedClient.payment.findUnique.mockResolvedValue(PENDING_PAYMENT);
      rawPrisma.approvalPolicy.findUnique.mockResolvedValue({ id: 'policy-1', requiredApprovals: 2, makerCanApproveOwn: false });
      rawPrisma.paymentApproval.findUnique.mockResolvedValue({ id: 'existing-decision' });

      await expect(service.approvePayment(ORG_ID, APPROVER_ID, 'pay-1')).rejects.toThrow(ConflictException);
    });

    it('rejects approving a payment that is not PENDING_APPROVAL', async () => {
      const { service, scopedClient } = makeService();
      scopedClient.payment.findUnique.mockResolvedValue({ ...PENDING_PAYMENT, status: 'APPROVED' });

      await expect(service.approvePayment(ORG_ID, APPROVER_ID, 'pay-1')).rejects.toThrow(ConflictException);
    });

    it('records progress without finalizing when quorum is not yet met (N-of-M)', async () => {
      const { service, scopedClient, rawPrisma, tx } = makeService();
      scopedClient.payment.findUnique.mockResolvedValue(PENDING_PAYMENT);
      rawPrisma.approvalPolicy.findUnique.mockResolvedValue({ id: 'policy-1', requiredApprovals: 2, makerCanApproveOwn: false });
      rawPrisma.paymentApproval.findUnique.mockResolvedValue(null);
      tx.paymentApproval.count.mockResolvedValue(1); // only this one decision so far, 2 required

      const result = await service.approvePayment(ORG_ID, APPROVER_ID, 'pay-1');

      expect(result.finalized).toBe(false);
      expect(result.approvedCount).toBe(1);
      expect(result.requiredApprovals).toBe(2);
      expect(tx.payment.update).not.toHaveBeenCalled();
      expect(tx.paymentStateTransition.create).not.toHaveBeenCalled();
    });

    it('finalizes to APPROVED once the required number of distinct approvals is reached', async () => {
      const { service, scopedClient, rawPrisma, tx, auditService } = makeService();
      scopedClient.payment.findUnique.mockResolvedValue(PENDING_PAYMENT);
      rawPrisma.approvalPolicy.findUnique.mockResolvedValue({ id: 'policy-1', requiredApprovals: 2, makerCanApproveOwn: false });
      rawPrisma.paymentApproval.findUnique.mockResolvedValue(null);
      tx.paymentApproval.count.mockResolvedValue(2); // quorum reached
      tx.payment.update.mockResolvedValue({ id: 'pay-1', status: 'APPROVED' });

      const result = await service.approvePayment(ORG_ID, APPROVER_ID, 'pay-1');

      expect(result.finalized).toBe(true);
      expect(tx.payment.update).toHaveBeenCalledWith({ where: { id: 'pay-1' }, data: { status: 'APPROVED' } });
      expect(tx.paymentStateTransition.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ fromState: 'PENDING_APPROVAL', toState: 'APPROVED', actorUserId: APPROVER_ID }),
        }),
      );
      expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'payment.approved' }), tx);
    });
  });

  describe('rejectPayment', () => {
    it('blocks the payment creator from rejecting their own payment', async () => {
      const { service, scopedClient, auditService } = makeService();
      scopedClient.payment.findUnique.mockResolvedValue(PENDING_PAYMENT);

      await expect(service.rejectPayment(ORG_ID, MAKER_ID, 'pay-1', 'not legitimate')).rejects.toThrow(ForbiddenException);
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'payment.reject_blocked_self_approval' }),
      );
    });

    it('rejects rejecting a payment that is not PENDING_APPROVAL', async () => {
      const { service, scopedClient } = makeService();
      scopedClient.payment.findUnique.mockResolvedValue({ ...PENDING_PAYMENT, status: 'CANCELLED' });

      await expect(service.rejectPayment(ORG_ID, APPROVER_ID, 'pay-1', 'too late')).rejects.toThrow(ConflictException);
    });

    it('rejects a second decision from the same approver on the same payment', async () => {
      const { service, scopedClient, rawPrisma } = makeService();
      scopedClient.payment.findUnique.mockResolvedValue(PENDING_PAYMENT);
      rawPrisma.paymentApproval.findUnique.mockResolvedValue({ id: 'existing-decision' });

      await expect(service.rejectPayment(ORG_ID, APPROVER_ID, 'pay-1', 'already decided once')).rejects.toThrow(
        ConflictException,
      );
    });

    it('transitions the payment straight to REJECTED on a single rejection (no quorum)', async () => {
      const { service, scopedClient, rawPrisma, tx, auditService } = makeService();
      scopedClient.payment.findUnique.mockResolvedValue(PENDING_PAYMENT);
      rawPrisma.paymentApproval.findUnique.mockResolvedValue(null);
      tx.payment.update.mockResolvedValue({ id: 'pay-1', status: 'REJECTED' });

      const result = await service.rejectPayment(ORG_ID, APPROVER_ID, 'pay-1', 'looks fraudulent');

      expect(result.status).toEqual('REJECTED');
      expect(tx.paymentApproval.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ decision: 'REJECTED', approverUserId: APPROVER_ID, reason: 'looks fraudulent' }),
        }),
      );
      expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'payment.rejected' }), tx);
    });
  });

  describe('listApprovals', () => {
    it('returns the decisions recorded so far alongside the policy requirement', async () => {
      const { service, scopedClient, rawPrisma } = makeService();
      scopedClient.payment.findUnique.mockResolvedValue(PENDING_PAYMENT);
      rawPrisma.paymentApproval.findMany.mockResolvedValue([
        { approverUserId: APPROVER_ID, decision: 'APPROVED' },
      ]);
      rawPrisma.approvalPolicy.findUnique.mockResolvedValue({ requiredApprovals: 2 });

      const result = await service.listApprovals(ORG_ID, 'pay-1');

      expect(result.approvedCount).toBe(1);
      expect(result.requiredApprovals).toBe(2);
      expect(result.decisions).toHaveLength(1);
    });
  });
});
