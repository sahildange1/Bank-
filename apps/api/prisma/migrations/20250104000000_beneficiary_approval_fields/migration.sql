-- Adds maker-checker and cooling-off tracking fields to beneficiaries
-- (Phase 7). Nullable throughout since this is additive to an
-- already-applied migration and existing rows (none in production yet,
-- but the column must still be a valid nullable add) have no value.
ALTER TABLE "beneficiaries" ADD COLUMN "createdByUserId" TEXT;
ALTER TABLE "beneficiaries" ADD COLUMN "verifiedAt" TIMESTAMP(3);
ALTER TABLE "beneficiaries" ADD COLUMN "verifiedByUserId" TEXT;
ALTER TABLE "beneficiaries" ADD COLUMN "rejectionReason" TEXT;

ALTER TABLE "beneficiaries" ADD CONSTRAINT "beneficiaries_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "beneficiaries" ADD CONSTRAINT "beneficiaries_verifiedByUserId_fkey" FOREIGN KEY ("verifiedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
