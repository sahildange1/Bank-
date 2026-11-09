import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Closes the gap demonstrated in Phase 3: foreign keys alone do not stop a
 * payment (or any tenant-owned row) created under one organization from
 * referencing another organization's data. Postgres has no way to know
 * "acct1 belongs to org1" is a rule that should apply across tables — only
 * application code can enforce that.
 *
 * This extension wraps every query against a tenant-owned model so that:
 *   - reads (findMany/findFirst/findUnique/count) are silently filtered to
 *     the current organizationId — a cross-org lookup returns "not found",
 *     not another tenant's row.
 *   - writes (create/update/delete, and their *Many variants) are rejected
 *     with a ForbiddenTenantAccessError if they would touch or create a row
 *     outside the current organizationId.
 *
 * Usage: never inject the raw PrismaService into a feature-module service
 * that touches tenant data. Instead inject TenantPrismaService and call
 * `.forOrg(organizationId)` to get a scoped client for the current
 * request's organization, sourced from the authenticated session — never
 * from a client-supplied value.
 */

export class ForbiddenTenantAccessError extends Error {
  constructor(model: string) {
    super(`Cross-tenant access denied on model "${model}"`);
    this.name = 'ForbiddenTenantAccessError';
  }
}

// Models that carry a direct organizationId column. Models that relate to an
// organization only indirectly (PaymentApproval, PaymentStateTransition,
// LedgerEntry, UserRole, RolePermission) are NOT listed here — they must be
// reached through their scoped parent (e.g. load the Payment via the scoped
// client first, then its approvals via `include`), which is safe because the
// parent lookup is itself organization-filtered.
const TENANT_SCOPED_MODELS = new Set([
  'User',
  'Role',
  'Account',
  'Beneficiary',
  'ApprovalPolicy',
  'Payment',
  'LedgerEntryGroup',
  'Document',
  'ApiClient',
  'AuditEvent',
  'Notification',
]);

const READ_OPERATIONS = new Set(['findMany', 'findFirst', 'findFirstOrThrow', 'count', 'aggregate', 'groupBy']);
const SINGLE_READ_OPERATIONS = new Set(['findUnique', 'findUniqueOrThrow']);
const WRITE_MANY_OPERATIONS = new Set(['updateMany', 'deleteMany']);
const WRITE_SINGLE_OPERATIONS = new Set(['update', 'delete', 'upsert']);
const CREATE_OPERATIONS = new Set(['create']);
const CREATE_MANY_OPERATIONS = new Set(['createMany']);

function injectOrgWhere(args: Record<string, unknown>, organizationId: string) {
  const where = (args.where ?? {}) as Record<string, unknown>;
  if ('organizationId' in where && where.organizationId !== organizationId) {
    // Caller explicitly asked for a different org's data — reject outright
    // rather than silently overriding, since that usually indicates a bug.
    return null;
  }
  args.where = { ...where, organizationId };
  return args;
}

interface AllOperationsArgs {
  model?: string;
  operation: string;
  args: unknown;
  query: (args: unknown) => Promise<unknown>;
}

export function withTenantScope(client: PrismaClient, organizationId: string) {
  if (!organizationId) {
    throw new Error('withTenantScope() requires a non-empty organizationId');
  }

  return client.$extends({
    name: `tenant-scope:${organizationId}`,
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }: AllOperationsArgs) {
          if (!model || !TENANT_SCOPED_MODELS.has(model)) {
            return query(args);
          }

          const typedArgs = args as Record<string, unknown>;

          if (READ_OPERATIONS.has(operation)) {
            const scoped = injectOrgWhere(typedArgs, organizationId);
            if (scoped === null) {
              throw new ForbiddenTenantAccessError(model);
            }
            return query(scoped);
          }

          if (SINGLE_READ_OPERATIONS.has(operation)) {
            // findUnique can only filter on unique fields, so organizationId
            // can't always go in `where` directly. Run the lookup, then
            // verify the result actually belongs to this tenant before
            // returning it.
            const result = await query(typedArgs);
            if (result && (result as Record<string, unknown>).organizationId !== organizationId) {
              return null;
            }
            return result;
          }

          if (WRITE_MANY_OPERATIONS.has(operation)) {
            const scoped = injectOrgWhere(typedArgs, organizationId);
            if (scoped === null) {
              throw new ForbiddenTenantAccessError(model);
            }
            return query(scoped);
          }

          if (WRITE_SINGLE_OPERATIONS.has(operation)) {
            // Verify-then-write: confirm the target row belongs to this
            // tenant before allowing the mutation, since update/delete/upsert
            // filter on unique fields that may not include organizationId.
            const where = (typedArgs.where ?? {}) as Record<string, unknown>;
            const existing = await (client as any)[model.charAt(0).toLowerCase() + model.slice(1)].findUnique({
              where,
              select: { organizationId: true },
            });
            if (operation !== 'upsert' && (!existing || existing.organizationId !== organizationId)) {
              throw new ForbiddenTenantAccessError(model);
            }
            if (operation === 'upsert' && existing && existing.organizationId !== organizationId) {
              throw new ForbiddenTenantAccessError(model);
            }
            return query(typedArgs);
          }

          if (CREATE_OPERATIONS.has(operation)) {
            const data = (typedArgs.data ?? {}) as Record<string, unknown>;
            if ('organizationId' in data && data.organizationId !== organizationId) {
              throw new ForbiddenTenantAccessError(model);
            }
            typedArgs.data = { ...data, organizationId };
            return query(typedArgs);
          }

          if (CREATE_MANY_OPERATIONS.has(operation)) {
            const data = (typedArgs.data ?? []) as Record<string, unknown>[];
            const bad = data.some((row) => 'organizationId' in row && row.organizationId !== organizationId);
            if (bad) {
              throw new ForbiddenTenantAccessError(model);
            }
            typedArgs.data = data.map((row) => ({ ...row, organizationId }));
            return query(typedArgs);
          }

          // Any operation not explicitly handled above (e.g. a future Prisma
          // method) is rejected rather than silently allowed unscoped.
          throw new ForbiddenTenantAccessError(model);
        },
      },
    },
  });
}

export type ScopedPrismaClient = ReturnType<typeof withTenantScope>;
