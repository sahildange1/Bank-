-- Adds idempotencyKey to ledger_entry_groups for postings that don't
-- originate from a Payment row (internal transfers, Phase 6).
ALTER TABLE "ledger_entry_groups" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "ledger_entry_groups_idempotencyKey_key" ON "ledger_entry_groups"("idempotencyKey");
