-- Phase 10: distinguishes customer-owned accounts from internal
-- settlement/suspense accounts (architecture §9's "destination-side
-- placeholder" for executed payments), so LedgerService has somewhere to
-- post the CREDIT side of money leaving the organization to an external
-- beneficiary without that plumbing leaking into customer-facing account
-- listings.

CREATE TYPE "AccountPurpose" AS ENUM ('CUSTOMER', 'SETTLEMENT');

ALTER TABLE "accounts" ADD COLUMN "purpose" "AccountPurpose" NOT NULL DEFAULT 'CUSTOMER';

-- At most one SETTLEMENT account per (organization, currency) — enforced
-- at the DB level, not just by getOrCreateSettlementAccount()'s app-level
-- find-then-create check, the same defense-in-depth posture used for
-- idempotency keys and the payment-approval unique constraint elsewhere
-- in this schema. A plain @@unique([organizationId, currency]) in
-- schema.prisma would also wrongly cap CUSTOMER accounts to one per
-- currency per org, so this is a partial index instead, expressed in raw
-- SQL the same way the tenant-scope enforcement is (Prisma's schema DSL
-- doesn't support partial unique indexes).
CREATE UNIQUE INDEX "accounts_settlement_org_currency_key"
  ON "accounts" ("organizationId", "currency")
  WHERE "purpose" = 'SETTLEMENT';
