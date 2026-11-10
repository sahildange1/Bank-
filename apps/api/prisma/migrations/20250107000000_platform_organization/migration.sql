-- Phase 13: identifies the internal organization whose users are platform
-- operators (bank staff who act across customer organizations).

ALTER TABLE "organizations" ADD COLUMN "isPlatform" BOOLEAN NOT NULL DEFAULT false;

-- At most one platform organization, enforced in the database rather than
-- only in seed code (a partial unique index on a constant expression;
-- Prisma's schema DSL can't express this, same as the Phase 10 index).
CREATE UNIQUE INDEX "organizations_single_platform" ON "organizations" ((true)) WHERE "isPlatform";
