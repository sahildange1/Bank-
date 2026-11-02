/**
 * Single source of truth for the permission catalog and default role
 * templates. Used by:
 *   - prisma/seed.ts — seeds the global Permission rows
 *   - OrganizationsService — materializes per-org Role + RolePermission rows
 *     at organization creation time (Role is per-org, see schema.prisma)
 *
 * Matches the permission list and default roles from architecture §6.
 */

export const PERMISSIONS: ReadonlyArray<{ key: string; description: string }> = [
  { key: 'accounts.read', description: 'View account details and balances' },
  { key: 'accounts.manage', description: 'Create/modify/freeze accounts' },
  // Not in the original brief's permission list (architecture §6), added in
  // Phase 7: there was no way to grant "can view beneficiaries" without also
  // granting beneficiaries.create, which is too broad for Viewer/Auditor/
  // Payment Approver. Same gap already flagged for users.read in Phase 5.
  { key: 'beneficiaries.read', description: 'View beneficiaries (sensitive fields masked unless also granted create/approve)' },
  { key: 'beneficiaries.create', description: 'Add or edit a beneficiary' },
  { key: 'beneficiaries.approve', description: 'Verify, reject, or re-enable a beneficiary' },
  { key: 'payments.create', description: 'Create and submit payments' },
  { key: 'payments.read', description: 'View payments and their status' },
  { key: 'payments.approve', description: 'Approve or reject pending payments' },
  { key: 'payments.cancel', description: 'Cancel a draft or pending payment' },
  { key: 'users.manage', description: 'Invite users and manage role assignments' },
  { key: 'reports.read', description: 'View and generate statements/reports' },
  { key: 'audit.read', description: 'View the organization audit trail' },
  // Added in Phase 10: running reconciliation surfaces every account's
  // true computed balance, which is sensitive in the same way raw ledger
  // access is — distinct from accounts.read (balances at rest) and
  // audit.read (the drift *event* history, not the on-demand check itself).
  { key: 'ledger.reconcile', description: 'Run on-demand ledger reconciliation and view drift reports' },
];

export const DEFAULT_ROLE_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  'Organization Admin': PERMISSIONS.map((p) => p.key),
  'Finance Manager': [
    'accounts.read',
    'accounts.manage',
    'beneficiaries.read',
    'beneficiaries.create',
    'beneficiaries.approve',
    'payments.create',
    'payments.read',
    'payments.cancel',
    'reports.read',
    'ledger.reconcile',
  ],
  'Payment Maker': [
    'accounts.read',
    'payments.create',
    'payments.read',
    'beneficiaries.read',
    'beneficiaries.create',
  ],
  'Payment Approver': ['accounts.read', 'payments.read', 'payments.approve', 'beneficiaries.read'],
  Viewer: ['accounts.read', 'payments.read', 'reports.read', 'beneficiaries.read'],
  Auditor: ['audit.read', 'payments.read', 'accounts.read', 'reports.read', 'beneficiaries.read'],
};

export const DEFAULT_ADMIN_ROLE_NAME = 'Organization Admin';
