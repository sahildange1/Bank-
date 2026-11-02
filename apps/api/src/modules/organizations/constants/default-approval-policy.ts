/**
 * Every organization needs at least one ApprovalPolicy covering the full
 * amount range, or Payments (Phase 8) would have nothing to resolve at
 * submission time: Payment.approvalPolicyId must be set to know how many
 * approvals a payment needs before Phase 9 can evaluate it.
 *
 * ApprovalPolicy CRUD itself — letting an org configure tiered policies
 * ("payments under $1,000 need 1 approval, over $10,000 need 2") — is
 * approval-domain configuration, not payment-domain logic, so it belongs
 * to Phase 9 (Approval workflows), not Phase 8. This single default policy
 * is what unblocks Phase 8 in the meantime, the same way Phase 5 seeded
 * default Roles before a Role-management UI existed. Phase 9 should let
 * an org add more policies and leave this one in place, rename it, or
 * replace it — nothing here assumes it's the only policy that will ever
 * exist.
 */
export const DEFAULT_APPROVAL_POLICY = {
  name: 'Standard',
  minAmountMinorUnits: 0n,
  maxAmountMinorUnits: null as bigint | null,
  requiredApprovals: 1,
  makerCanApproveOwn: false,
} as const;
