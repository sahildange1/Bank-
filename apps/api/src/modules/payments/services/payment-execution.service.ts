import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { TenantPrismaService } from '../../../common/prisma/tenant-prisma.service';
import { AuditService } from '../../audit/services/audit.service';
import { LedgerService } from '../../ledger/services/ledger.service';
import { PaymentStateMachine, PaymentStatus } from './payment-state-machine';
import { MockPaymentProviderService } from './mock-payment-provider.service';

/**
 * APPROVED -> PROCESSING -> COMPLETED/FAILED (architecture §8), the one
 * part of the state machine Phase 8 and Phase 9 both deliberately left
 * without a caller. This is also where architecture §9's ledger diagram
 * ("Payment: APPROVED -> Ledger Service ... CREDIT destination-side
 * placeholder") actually gets wired up — LedgerService.postDoubleEntry()
 * has taken an optional `paymentId` since Phase 6 specifically so this
 * moment could link a ledger posting back to the payment that caused it.
 *
 * Architecture §8 is explicit that this transition is "driven by a
 * background worker calling the mock payment provider, never inline in
 * the request/response cycle" — unlike ReconciliationService's on-demand
 * job (bounded, fast, fine to run synchronously from an HTTP handler),
 * a provider call is exactly the kind of slow/flaky operation that rule
 * exists to keep off the request thread. No BullMQ/Redis queue exists in
 * this codebase yet (flagged as deferred since Phase 1), so this service
 * is deliberately NOT wired to a controller/HTTP route in this phase —
 * only `executePayment()` directly, or `executeAllApproved()` as what a
 * future repeatable worker job would call. Wiring one of those to an
 * actual queue is this phase's main open item; building a synchronous
 * execute-via-HTTP endpoint instead would just relocate the architecture
 * violation Phase 10 is explicitly trying to avoid.
 */
@Injectable()
export class PaymentExecutionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly auditService: AuditService,
    private readonly ledgerService: LedgerService,
    private readonly stateMachine: PaymentStateMachine,
    private readonly provider: MockPaymentProviderService,
  ) {}

  async executePayment(organizationId: string, actorUserId: string, paymentId: string) {
    const scoped = this.tenantPrisma.forOrg(organizationId);
    const payment = await scoped.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException();

    // APPROVED -> PROCESSING is its own committed transition before the
    // provider call, not bundled with it: "processing has started" is a
    // true fact the instant we decide to call the provider, independent
    // of whether that call ends up succeeding, failing, or timing out.
    this.stateMachine.assertValidTransition(payment.status as PaymentStatus, 'PROCESSING');
    await this.transition(organizationId, actorUserId, paymentId, payment.status as PaymentStatus, 'PROCESSING', {
      action: 'payment.processing_started',
    });

    const beneficiary = await scoped.beneficiary.findUnique({ where: { id: payment.beneficiaryId } });
    if (!beneficiary) {
      // Can't happen in the normal flow (submitPayment() already required
      // the beneficiary to exist and be eligible), but a payment can sit
      // APPROVED for a while — defend against the beneficiary having been
      // deleted or disabled out from under it in the meantime, the same
      // posture submitPayment() takes toward account/beneficiary staleness.
      await this.transition(organizationId, actorUserId, paymentId, 'PROCESSING', 'FAILED', {
        action: 'payment.failed',
        metadata: { reason: 'Beneficiary no longer exists.' },
      });
      return this.getPayment(organizationId, paymentId);
    }

    let providerResult;
    try {
      providerResult = await this.provider.submit({
        paymentId,
        amountMinorUnits: payment.amountMinorUnits,
        currency: payment.currency,
        beneficiaryAccountNumber: beneficiary.accountNumber,
      });
    } catch (err) {
      // The provider call itself threw (network error, etc. — this is a
      // MOCK provider so that shouldn't happen today, but a real
      // integration will fail sometimes). Never leave the payment stuck
      // in PROCESSING with no resolution.
      await this.transition(organizationId, actorUserId, paymentId, 'PROCESSING', 'FAILED', {
        action: 'payment.failed',
        metadata: { reason: `Provider call threw: ${err instanceof Error ? err.message : String(err)}` },
      });
      return this.getPayment(organizationId, paymentId);
    }

    if (!providerResult.success) {
      await this.transition(organizationId, actorUserId, paymentId, 'PROCESSING', 'FAILED', {
        action: 'payment.failed',
        metadata: { reason: providerResult.failureReason ?? 'Provider declined the payment.' },
      });
      return this.getPayment(organizationId, paymentId);
    }

    try {
      const settlementAccount = await this.ledgerService.getOrCreateSettlementAccount(
        organizationId,
        payment.currency,
      );
      await this.ledgerService.postDoubleEntry({
        organizationId,
        actorUserId,
        description: `Payment ${paymentId} execution`,
        idempotencyKey: `payment-execution-${paymentId}`,
        paymentId,
        entries: [
          { accountId: payment.sourceAccountId, direction: 'DEBIT', amountMinorUnits: payment.amountMinorUnits, currency: payment.currency },
          { accountId: settlementAccount.id, direction: 'CREDIT', amountMinorUnits: payment.amountMinorUnits, currency: payment.currency },
        ],
      });
    } catch (err) {
      // The provider says it succeeded but the ledger posting failed
      // (insufficient funds discovered only now, a concurrency conflict,
      // etc.). Money never actually left the organization's books — this
      // is a FAILED payment, not a COMPLETED one with no ledger trail.
      await this.transition(organizationId, actorUserId, paymentId, 'PROCESSING', 'FAILED', {
        action: 'payment.failed',
        metadata: {
          reason: `Provider reported success but the ledger posting failed: ${err instanceof Error ? err.message : String(err)}`,
          providerReference: providerResult.providerReference,
        },
      });
      return this.getPayment(organizationId, paymentId);
    }

    await this.transition(organizationId, actorUserId, paymentId, 'PROCESSING', 'COMPLETED', {
      action: 'payment.completed',
      metadata: { providerReference: providerResult.providerReference },
    });
    return this.getPayment(organizationId, paymentId);
  }

  /**
   * What a future repeatable worker job (BullMQ, once that infra exists —
   * see this file's own doc comment) would call on a schedule: every
   * APPROVED payment, across every organization. Cross-tenant by design,
   * same reasoning as ReconciliationService.reconcileAllOrganizations()
   * and TenantPrismaService.raw()'s own doc comment.
   */
  async executeAllApproved(actorUserId: string) {
    const approved = await this.prisma.payment.findMany({ where: { status: 'APPROVED' } });
    const results = [];
    for (const payment of approved) {
      results.push(await this.executePayment(payment.organizationId, actorUserId, payment.id));
    }
    return results;
  }

  private async getPayment(organizationId: string, paymentId: string) {
    const scoped = this.tenantPrisma.forOrg(organizationId);
    return scoped.payment.findUnique({ where: { id: paymentId } });
  }

  private async transition(
    organizationId: string,
    actorUserId: string,
    paymentId: string,
    fromState: PaymentStatus,
    toState: PaymentStatus,
    audit: { action: string; metadata?: Record<string, unknown> },
  ): Promise<void> {
    this.stateMachine.assertValidTransition(fromState, toState);
    await this.prisma.$transaction(async (tx: any) => {
      await tx.payment.update({ where: { id: paymentId }, data: { status: toState } });
      await tx.paymentStateTransition.create({
        data: { paymentId, fromState, toState, actorUserId },
      });
      await this.auditService.record(
        {
          organizationId,
          actorId: actorUserId,
          action: audit.action,
          resourceType: 'Payment',
          resourceId: paymentId,
          previousState: { status: fromState },
          newState: { status: toState },
          metadata: audit.metadata,
        },
        tx,
      );
    });
  }
}
