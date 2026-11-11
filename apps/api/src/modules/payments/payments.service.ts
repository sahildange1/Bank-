import { BadRequestException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantPrismaService } from '../../common/prisma/tenant-prisma.service';
import { AuditService } from '../audit/services/audit.service';
import { BeneficiariesService } from '../beneficiaries/beneficiaries.service';
import { PaymentStateMachine, PaymentStatus } from './services/payment-state-machine';
import { CreatePaymentDto } from './dto/create-payment.dto';

/**
 * Phase 8 scope (see payment-state-machine.ts for the full reasoning):
 * payment creation, DRAFT -> PENDING_APPROVAL (submit), and
 * DRAFT|PENDING_APPROVAL -> CANCELLED (cancel). Approval/rejection
 * (PENDING_APPROVAL -> APPROVED/REJECTED) and execution
 * (APPROVED -> PROCESSING -> COMPLETED/FAILED) are Phase 9/10.
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService, // PaymentStateTransition reads only — see getPaymentHistory
    private readonly tenantPrisma: TenantPrismaService,
    private readonly auditService: AuditService,
    private readonly beneficiariesService: BeneficiariesService,
    private readonly stateMachine: PaymentStateMachine,
  ) {}

  /**
   * Idempotent on `dto.idempotencyKey` (schema: Payment.idempotencyKey is
   * @unique) — the same pattern as LedgerService.postDoubleEntry (Phase 6):
   * calling again with the same key returns the existing DRAFT rather than
   * creating a duplicate, satisfying "prevent duplicate payment submission"
   * (brief §9) at the creation step. A second, independent duplicate check
   * happens again at submit() — see there for why both matter.
   */
  async createPayment(organizationId: string, actorUserId: string, dto: CreatePaymentDto) {
    const existing = await this.prisma.payment.findUnique({ where: { idempotencyKey: dto.idempotencyKey } });
    if (existing) {
      if (existing.organizationId !== organizationId) {
        // Same defensive posture as the tenant-scope extension: don't
        // confirm another org's payment exists, just refuse to reuse the key.
        throw new BadRequestException('This idempotency key has already been used.');
      }
      return existing;
    }

    const scoped = this.tenantPrisma.forOrg(organizationId);
    const [account, beneficiary] = await Promise.all([
      scoped.account.findUnique({ where: { id: dto.sourceAccountId } }),
      scoped.beneficiary.findUnique({ where: { id: dto.beneficiaryId } }),
    ]);
    if (!account) throw new NotFoundException('Source account not found.');
    if (!beneficiary) throw new NotFoundException('Beneficiary not found.');
    if (!beneficiary.active) {
      throw new BadRequestException('Cannot create a payment to a disabled beneficiary.');
    }
    // Deliberately NOT checking isEligibleForPayments() here — a DRAFT is
    // allowed to reference a beneficiary still in verification/cooling-off,
    // since drafting isn't a commitment to pay. Eligibility is enforced at
    // submit(), the actual point of committing to the approval queue.

    if (account.currency !== dto.currency) {
      throw new BadRequestException(
        `Currency mismatch: payment is ${dto.currency}, source account is ${account.currency}.`,
      );
    }

    const amount = BigInt(dto.amountMinorUnits);
    if (amount <= 0n) {
      throw new BadRequestException('Payment amount must be positive.');
    }

    const payment = await scoped.payment.create({
      data: {
        organizationId, // also injected/verified by the tenant extension
        sourceAccountId: dto.sourceAccountId,
        beneficiaryId: dto.beneficiaryId,
        createdByUserId: actorUserId,
        idempotencyKey: dto.idempotencyKey,
        amountMinorUnits: amount,
        currency: dto.currency,
        status: 'DRAFT',
        reference: dto.reference,
        scheduledFor: dto.scheduledFor ? new Date(dto.scheduledFor) : undefined,
      },
    });

    await this.auditService.record({
      organizationId,
      actorId: actorUserId,
      action: 'payment.created',
      resourceType: 'Payment',
      resourceId: payment.id,
      newState: {
        amountMinorUnits: amount.toString(),
        currency: dto.currency,
        sourceAccountId: dto.sourceAccountId,
        beneficiaryId: dto.beneficiaryId,
      },
    });

    return payment;
  }

  async listPayments(organizationId: string, status?: PaymentStatus) {
    const scoped = this.tenantPrisma.forOrg(organizationId);
    return scoped.payment.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
    });
  }

  async getPayment(organizationId: string, paymentId: string) {
    const scoped = this.tenantPrisma.forOrg(organizationId);
    const payment = await scoped.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException();
    return payment;
  }

  /**
   * PaymentStateTransition has no organizationId column (reached only
   * through its scoped parent — same pattern as LedgerEntry in
   * AccountsService.getAccountTransactions, Phase 6), so this confirms
   * ownership via the scoped client before querying it with the raw one.
   */
  async getPaymentHistory(organizationId: string, paymentId: string) {
    const scoped = this.tenantPrisma.forOrg(organizationId);
    const payment = await scoped.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException();

    return this.prisma.paymentStateTransition.findMany({
      where: { paymentId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * DRAFT -> PENDING_APPROVAL. This is the real commitment point: resolves
   * which ApprovalPolicy governs the payment (brief §7, "make approval
   * rules configurable"), and re-validates everything that could have gone
   * stale since DRAFT was created (account/beneficiary status, beneficiary
   * eligibility including the cooling-off period from Phase 7) — a DRAFT
   * can sit around indefinitely before submission.
   */
  async submitPayment(organizationId: string, actorUserId: string, paymentId: string) {
    const scoped = this.tenantPrisma.forOrg(organizationId);
    const payment = await scoped.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException();

    this.stateMachine.assertValidTransition(payment.status as PaymentStatus, 'PENDING_APPROVAL');

    const [account, beneficiary] = await Promise.all([
      scoped.account.findUnique({ where: { id: payment.sourceAccountId } }),
      scoped.beneficiary.findUnique({ where: { id: payment.beneficiaryId } }),
    ]);
    if (!account || account.status !== 'ACTIVE') {
      throw new UnprocessableEntityException('Source account is not active.');
    }
    if (!beneficiary || !this.beneficiariesService.isEligibleForPayments(beneficiary)) {
      throw new UnprocessableEntityException(
        'Beneficiary is not eligible for payments yet (must be verified and past the cooling-off period).',
      );
    }

    const policy = await this.resolveApprovalPolicy(organizationId, payment.amountMinorUnits, payment.currency);
    if (!policy) {
      throw new UnprocessableEntityException('No approval policy covers this payment amount.');
    }

    const updated = await this.prisma.$transaction(async (tx: any) => {
      const result = await tx.payment.update({
        where: { id: paymentId },
        data: { status: 'PENDING_APPROVAL', approvalPolicyId: policy.id },
      });
      await tx.paymentStateTransition.create({
        data: {
          paymentId,
          fromState: payment.status,
          toState: 'PENDING_APPROVAL',
          actorUserId,
        },
      });
      await this.auditService.record(
        {
          organizationId,
          actorId: actorUserId,
          action: 'payment.submitted',
          resourceType: 'Payment',
          resourceId: paymentId,
          previousState: { status: payment.status },
          newState: { status: 'PENDING_APPROVAL', approvalPolicyId: policy.id },
        },
        tx,
      );
      return result;
    });

    return updated;
  }

  async cancelPayment(organizationId: string, actorUserId: string, paymentId: string, reason?: string) {
    const scoped = this.tenantPrisma.forOrg(organizationId);
    const payment = await scoped.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException();

    this.stateMachine.assertValidTransition(payment.status as PaymentStatus, 'CANCELLED');

    const updated = await this.prisma.$transaction(async (tx: any) => {
      const result = await tx.payment.update({ where: { id: paymentId }, data: { status: 'CANCELLED' } });
      await tx.paymentStateTransition.create({
        data: { paymentId, fromState: payment.status, toState: 'CANCELLED', actorUserId, reason },
      });
      await this.auditService.record(
        {
          organizationId,
          actorId: actorUserId,
          action: 'payment.cancelled',
          resourceType: 'Payment',
          resourceId: paymentId,
          previousState: { status: payment.status },
          newState: { status: 'CANCELLED' },
          metadata: reason ? { reason } : undefined,
        },
        tx,
      );
      return result;
    });

    return updated;
  }

  /**
   * Picks the ApprovalPolicy whose [min, max] range contains the amount.
   * With only the single default "Standard" policy an org gets at creation
   * (see constants/default-approval-policy.ts), there's never more than
   * one candidate yet. Real tie-breaking between overlapping,
   * organization-configured policies is Phase 9's problem once policy
   * management exists — this picks the tightest (highest minimum) match
   * deterministically in the meantime, rather than leaving it unspecified.
   */
  private async resolveApprovalPolicy(organizationId: string, amountMinorUnits: bigint, currency: string) {
    const scoped = this.tenantPrisma.forOrg(organizationId);
    const candidates = await scoped.approvalPolicy.findMany({
      where: {
        minAmountMinorUnits: { lte: amountMinorUnits },
        OR: [{ maxAmountMinorUnits: null }, { maxAmountMinorUnits: { gte: amountMinorUnits } }],
      },
      orderBy: { minAmountMinorUnits: 'desc' },
    });
    // currency is accepted for a future multi-currency policy model
    // (Phase 1 §18 open question) — policies aren't currency-scoped yet,
    // so it's unused for now but kept in the signature rather than
    // silently dropped, so this method's contract doesn't change later.
    void currency;
    return candidates[0] ?? null;
  }
}
