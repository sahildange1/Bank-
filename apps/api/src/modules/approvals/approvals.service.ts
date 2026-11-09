import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantPrismaService } from '../../common/prisma/tenant-prisma.service';
import { AuditService } from '../audit/services/audit.service';
import { PaymentStateMachine, PaymentStatus } from '../payments/services/payment-state-machine';
import { NotificationsService } from '../notifications/services/notifications.service';

/**
 * Phase 9 scope: PENDING_APPROVAL -> APPROVED/REJECTED (see
 * payment-state-machine.ts's Phase 8 scope note — this is the module it
 * described as "approval-domain logic, not payment-domain logic"). What
 * happens once a payment reaches APPROVED (execution against the mock
 * payment provider, APPROVED -> PROCESSING -> COMPLETED/FAILED) is Phase 10.
 *
 * Two rules from architecture §7/§8 drive everything here:
 *  - Maker-checker: whoever created the payment cannot also decide its
 *    approval, unless the resolved policy explicitly opts out via
 *    `makerCanApproveOwn` (same shape as Beneficiary verification in
 *    Phase 7, now applied to the amount that actually moves money).
 *  - N-of-M approval: a policy's `requiredApprovals` is a count, not a
 *    boolean. A single APPROVED decision records progress; the payment
 *    only transitions to APPROVED once enough distinct approvers have
 *    signed off. A single REJECTED decision, by contrast, ends it
 *    immediately — there's no quorum for "stop paying this".
 *
 * `PaymentApproval` has no organizationId column (same pattern as
 * `PaymentStateTransition`, Phase 8) — tenant ownership of the parent
 * Payment is confirmed via the scoped client first, then the raw client
 * is used for the approval-table reads/writes themselves.
 */
@Injectable()
export class ApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly auditService: AuditService,
    private readonly stateMachine: PaymentStateMachine,
    private readonly notifications: NotificationsService,
  ) {}

  async listApprovals(organizationId: string, paymentId: string) {
    const payment = await this.getOwnedPayment(organizationId, paymentId);
    const [decisions, policy] = await Promise.all([
      this.prisma.paymentApproval.findMany({ where: { paymentId }, orderBy: { decidedAt: 'asc' } }),
      payment.approvalPolicyId
        ? this.prisma.approvalPolicy.findUnique({ where: { id: payment.approvalPolicyId } })
        : null,
    ]);
    const approvedCount = decisions.filter((d: { decision: string }) => d.decision === 'APPROVED').length;
    return {
      paymentId,
      status: payment.status,
      requiredApprovals: policy?.requiredApprovals ?? null,
      approvedCount,
      decisions,
    };
  }

  async approvePayment(organizationId: string, actorUserId: string, paymentId: string, reason?: string) {
    const scoped = this.tenantPrisma.forOrg(organizationId);
    const payment = await scoped.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException();

    if (payment.status !== 'PENDING_APPROVAL') {
      throw new ConflictException('Payment is not pending approval.');
    }
    if (!payment.approvalPolicyId) {
      // Can't happen via the normal submitPayment() path (it always sets
      // approvalPolicyId before moving to PENDING_APPROVAL), but a direct
      // DB write or a future caller bypassing that path shouldn't get a
      // null-pointer instead of a clear error.
      throw new ConflictException('This payment has no approval policy attached.');
    }
    const policy = await this.prisma.approvalPolicy.findUnique({ where: { id: payment.approvalPolicyId } });
    if (!policy) throw new ConflictException("This payment's approval policy no longer exists.");

    if (payment.createdByUserId === actorUserId && !policy.makerCanApproveOwn) {
      await this.auditService.record({
        organizationId,
        actorId: actorUserId,
        action: 'payment.approve_blocked_self_approval',
        resourceType: 'Payment',
        resourceId: paymentId,
      });
      throw new ForbiddenException('You cannot approve a payment you created yourself.');
    }

    // Pre-check for a friendlier error than the raw unique-constraint
    // violation; the @@unique([paymentId, approverUserId]) constraint in
    // the schema is the real backstop against a concurrent double-decision
    // by the same approver (same defense-in-depth posture as the
    // idempotencyKey checks in LedgerService/PaymentsService).
    const existingDecision = await this.prisma.paymentApproval.findUnique({
      where: { paymentId_approverUserId: { paymentId, approverUserId: actorUserId } },
    });
    if (existingDecision) {
      throw new ConflictException('You have already recorded a decision on this payment.');
    }

    const result = await this.prisma.$transaction(async (tx: any) => {
      await tx.paymentApproval.create({
        data: { paymentId, approverUserId: actorUserId, decision: 'APPROVED', reason },
      });

      await this.auditService.record(
        {
          organizationId,
          actorId: actorUserId,
          action: 'payment.approval_recorded',
          resourceType: 'Payment',
          resourceId: paymentId,
          metadata: reason ? { reason } : undefined,
        },
        tx,
      );

      const approvedCount = await tx.paymentApproval.count({ where: { paymentId, decision: 'APPROVED' } });

      if (approvedCount < policy.requiredApprovals) {
        // Quorum not yet met: record progress, leave status as
        // PENDING_APPROVAL. No PaymentStateTransition row — nothing
        // transitioned yet, and that table is for status changes only.
        return { payment, approvedCount, requiredApprovals: policy.requiredApprovals, finalized: false };
      }

      this.stateMachine.assertValidTransition(payment.status as PaymentStatus, 'APPROVED');
      const updated = await tx.payment.update({ where: { id: paymentId }, data: { status: 'APPROVED' } });
      await tx.paymentStateTransition.create({
        data: { paymentId, fromState: payment.status, toState: 'APPROVED', actorUserId },
      });
      await this.auditService.record(
        {
          organizationId,
          actorId: actorUserId,
          action: 'payment.approved',
          resourceType: 'Payment',
          resourceId: paymentId,
          previousState: { status: payment.status },
          newState: { status: 'APPROVED' },
          metadata: { approvedCount, requiredApprovals: policy.requiredApprovals },
        },
        tx,
      );
      return { payment: updated, approvedCount, requiredApprovals: policy.requiredApprovals, finalized: true };
    });

    // Phase 12: tell the maker once the payment is finalized. Sent after the
    // transaction commits and best-effort (notify() never throws), so a
    // notification problem can't undo or fail an approval.
    if (result.finalized && payment.createdByUserId) {
      await this.notifications.notify({
        organizationId,
        userId: payment.createdByUserId,
        type: 'payment.approved',
        title: 'Payment approved',
        body: 'Your payment has been approved and is queued for execution.',
        resourceType: 'Payment',
        resourceId: paymentId,
        email: true,
      });
    }

    return result;
  }

  async rejectPayment(organizationId: string, actorUserId: string, paymentId: string, reason: string) {
    const scoped = this.tenantPrisma.forOrg(organizationId);
    const payment = await scoped.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException();

    if (payment.status !== 'PENDING_APPROVAL') {
      throw new ConflictException('Payment is not pending approval.');
    }

    // Unlike approval, rejection isn't gated by makerCanApproveOwn: that
    // flag exists to let a trusted maker clear their own payment, not to
    // let them be the one who kills someone else's objection path. A
    // maker who wants out of their own payment already has cancelPayment().
    if (payment.createdByUserId === actorUserId) {
      await this.auditService.record({
        organizationId,
        actorId: actorUserId,
        action: 'payment.reject_blocked_self_approval',
        resourceType: 'Payment',
        resourceId: paymentId,
      });
      throw new ForbiddenException('You cannot reject a payment you created yourself. Cancel it instead.');
    }

    const existingDecision = await this.prisma.paymentApproval.findUnique({
      where: { paymentId_approverUserId: { paymentId, approverUserId: actorUserId } },
    });
    if (existingDecision) {
      throw new ConflictException('You have already recorded a decision on this payment.');
    }

    const updated = await this.prisma.$transaction(async (tx: any) => {
      await tx.paymentApproval.create({
        data: { paymentId, approverUserId: actorUserId, decision: 'REJECTED', reason },
      });

      this.stateMachine.assertValidTransition(payment.status as PaymentStatus, 'REJECTED');
      const result = await tx.payment.update({ where: { id: paymentId }, data: { status: 'REJECTED' } });
      await tx.paymentStateTransition.create({
        data: { paymentId, fromState: payment.status, toState: 'REJECTED', actorUserId, reason },
      });
      await this.auditService.record(
        {
          organizationId,
          actorId: actorUserId,
          action: 'payment.rejected',
          resourceType: 'Payment',
          resourceId: paymentId,
          previousState: { status: payment.status },
          newState: { status: 'REJECTED' },
          metadata: { reason },
        },
        tx,
      );
      return result;
    });

    if (payment.createdByUserId) {
      await this.notifications.notify({
        organizationId,
        userId: payment.createdByUserId,
        type: 'payment.rejected',
        title: 'Payment rejected',
        body: 'Your payment was rejected by an approver. Open the payment for the reason.',
        resourceType: 'Payment',
        resourceId: paymentId,
        email: true,
      });
    }

    return updated;
  }

  private async getOwnedPayment(organizationId: string, paymentId: string) {
    const scoped = this.tenantPrisma.forOrg(organizationId);
    const payment = await scoped.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException();
    return payment;
  }
}
