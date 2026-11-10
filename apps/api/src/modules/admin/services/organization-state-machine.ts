import { ConflictException, Injectable } from '@nestjs/common';

export type OrgStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
export type OrgAction = 'approve' | 'suspend' | 'reactivate' | 'close';

/**
 * Organization lifecycle, driven only by platform operators:
 *
 *   PENDING   --approve-->    ACTIVE        (onboarding accepted)
 *   ACTIVE    --suspend-->    SUSPENDED     (reversible block)
 *   SUSPENDED --reactivate--> ACTIVE
 *   PENDING | ACTIVE | SUSPENDED --close--> CLOSED   (terminal; a PENDING
 *                                           close is how an application is rejected)
 *
 * CLOSED has no outgoing edge on purpose: reopening a closed customer is a
 * new onboarding, not a status flip.
 */
const TRANSITIONS: Readonly<Record<OrgAction, { from: readonly OrgStatus[]; to: OrgStatus }>> = {
  approve: { from: ['PENDING'], to: 'ACTIVE' },
  suspend: { from: ['ACTIVE'], to: 'SUSPENDED' },
  reactivate: { from: ['SUSPENDED'], to: 'ACTIVE' },
  close: { from: ['PENDING', 'ACTIVE', 'SUSPENDED'], to: 'CLOSED' },
};

export const ACTIONS_REQUIRING_REASON: readonly OrgAction[] = ['suspend', 'close'];

@Injectable()
export class OrganizationStateMachine {
  /** Returns the target status, or throws 409 if `action` isn't allowed from `current`. */
  target(current: OrgStatus, action: OrgAction): OrgStatus {
    const rule = TRANSITIONS[action];
    if (!rule.from.includes(current)) {
      throw new ConflictException(`Cannot ${action} an organization that is ${current}.`);
    }
    return rule.to;
  }

  allowedFrom(action: OrgAction): readonly OrgStatus[] {
    return TRANSITIONS[action].from;
  }
}
