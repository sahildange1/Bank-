/**
 * The explicit payment state machine from architecture §8. No controller or
 * service is allowed to write `payment.status` directly — every transition
 * goes through `PaymentStateMachine.assertValidTransition()` first, which
 * throws on anything not in this table. "Do not allow arbitrary status
 * changes" (brief §8) is enforced structurally, not by convention.
 *
 * Scope note: Phase 8 (this phase) implements callers for DRAFT ->
 * PENDING_APPROVAL (submit) and DRAFT|PENDING_APPROVAL -> CANCELLED
 * (cancel). PENDING_APPROVAL -> APPROVED/REJECTED belongs to Phase 9
 * (Approval workflows) — the N-of-M policy evaluation and maker-checker
 * self-approval check are approval-domain logic, not payment-domain logic.
 * APPROVED -> PROCESSING -> COMPLETED/FAILED (the mock payment provider
 * execution) also belongs to Phase 9/10, since nothing reaches APPROVED
 * until Phase 9 exists. The full table is defined now — not left for
 * Phase 9 to invent — so this file is the single source of truth for what
 * transitions are ever legal, even before every transition has a caller.
 */
import { Injectable, ConflictException } from '@nestjs/common';

export type PaymentStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED';

const TRANSITION_TABLE: Record<PaymentStatus, readonly PaymentStatus[]> = {
  DRAFT: ['PENDING_APPROVAL', 'CANCELLED'],
  PENDING_APPROVAL: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: ['PROCESSING'],
  PROCESSING: ['COMPLETED', 'FAILED'],
  REJECTED: [],
  CANCELLED: [],
  COMPLETED: [],
  FAILED: [],
};

@Injectable()
export class PaymentStateMachine {
  /** Throws ConflictException if `from -> to` is not a legal transition. Callers must check this BEFORE writing the new status, inside the same DB transaction as the write and the PaymentStateTransition audit row. */
  assertValidTransition(from: PaymentStatus, to: PaymentStatus): void {
    const allowed = TRANSITION_TABLE[from];
    if (!allowed?.includes(to)) {
      throw new ConflictException(`Invalid payment state transition: ${from} -> ${to}`);
    }
  }

  isTerminal(status: PaymentStatus): boolean {
    return TRANSITION_TABLE[status].length === 0;
  }
}
