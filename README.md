# Corporate Banking Platform (Sandbox)

A prototype corporate banking platform — multi-tenant, maker-checker payment
approvals, double-entry ledger, immutable audit trail. **No real money
movement**: payments run against a mock/sandbox provider.

See `docs/architecture/phase1-architecture.md` for the full architecture,
data model, and phased implementation plan.

## Status

Phases 1–12 of the phased plan (`docs/architecture/phase1-architecture.md`
§14) are implemented:

- **Phase 2** — monorepo scaffolding
- **Phase 3** — full Prisma schema + initial migration
- **Phase 4** — authentication (password/argon2id, TOTP MFA, sessions,
  tenant-scoping Prisma extension, permission guards, global error envelope)
- **Phase 5** — organization signup, default RBAC role provisioning, user
  invite/accept/role-management/enable-disable
- **Phase 6** — accounts, internal transfers, and the core double-entry
  `LedgerService` (pulled forward from Phase 10 — see that module's doc
  comment for why)
- **Phase 7** — beneficiaries: create/edit/disable/re-enable, maker-checker
  verification (creator cannot verify or reject their own submission,
  audited either way), a 1-hour cooling-off period before a newly-verified
  beneficiary is payment-eligible, and account-number masking for callers
  without `beneficiaries.create`/`approve`
- **Phase 8** — payment creation and the DRAFT→PENDING_APPROVAL (submit) /
  DRAFT\|PENDING_APPROVAL→CANCELLED (cancel) transitions, with the full
  8-state machine (architecture §8) defined as the single source of truth
  for every legal transition, even the ones Phase 9 will add callers for.
  Submission re-validates account/beneficiary status, enforces the Phase 7
  cooling-off period, and resolves which `ApprovalPolicy` governs the
  payment by amount range. Every organization now gets one default
  "Standard" policy (unlimited range, 1 approval required) at creation, so
  Payments has something to resolve before Phase 9 builds real policy
  management.
- **Phase 9** — approval workflows: `PENDING_APPROVAL → APPROVED/REJECTED`,
  the two transitions Phase 8 deliberately left without a caller. Maker-
  checker applies to the decision itself now, not just beneficiary
  verification: whoever created the payment cannot approve *or* reject it
  (audited either way, same pattern as Phase 7), unless the resolved
  `ApprovalPolicy.makerCanApproveOwn` explicitly opts out. Approval is
  N-of-M — `ApprovalPolicy.requiredApprovals` is a count, so one `APPROVED`
  decision records progress and the payment only moves to `APPROVED` once
  enough *distinct* approvers (one decision per approver per payment,
  enforced by a DB unique constraint, not just an app-level check) have
  signed off. Rejection has no quorum: a single `REJECTED` decision ends
  the payment immediately. New routes: `GET /payments/:id/approvals`,
  `POST /payments/:id/approve`, `POST /payments/:id/reject`
  (`payments.approve` permission, already granted to the Payment Approver
  role since Phase 5).
- **Phase 10** — ledger/reconciliation. Two parts:
  - **Reconciliation**: `ReconciliationService` recomputes every account's
    true balance from `SUM(LedgerEntry)` (never trusting the
    `Account.balanceMinorUnits` cache) and reports drift without ever
    auto-correcting it — a detected drift is a bug to investigate, not
    something to silently paper over. `POST /ledger/reconcile`
    (`ledger.reconcile` permission) runs it on demand; it's bounded and
    fast enough to run synchronously from an HTTP handler, unlike payment
    execution below.
  - **Payment execution**: `APPROVED → PROCESSING → COMPLETED/FAILED`
    (architecture §8), the transitions Phase 8 and 9 both deliberately
    left uncalled. A new `AccountPurpose` (`CUSTOMER`/`SETTLEMENT`)
    distinguishes real customer accounts from the internal "destination-
    side placeholder" account (architecture §9) that absorbs the CREDIT
    side of money leaving the organization to an external beneficiary —
    one per (organization, currency), enforced by a DB partial unique
    index, and filtered out of every customer-facing account endpoint.
    `PaymentExecutionService` calls a `MockPaymentProviderService`
    (injectable, so a real integration can replace it without touching
    the execution logic) and, on success, posts the DEBIT/CREDIT through
    `LedgerService` linked back to the payment via
    `LedgerEntryGroup.paymentId`. Every exit path — provider decline,
    provider throw, or a ledger-posting failure *after* the provider
    reported success — resolves to `FAILED` rather than leaving a payment
    stuck in `PROCESSING` with no ledger trail.
  - **Deliberately not exposed over HTTP**: architecture §8 is explicit
    that `APPROVED → PROCESSING` is "driven by a background worker...
    never inline in the request/response cycle," specifically because a
    provider call can be slow or flaky in a way reconciliation's job
    isn't. No BullMQ/Redis queue exists in this codebase yet (flagged as
    deferred since Phase 1), so `PaymentExecutionService.executePayment()`
    is fully built and tested but only callable directly (or via
    `executeAllApproved()`, what a future repeatable worker job would
    call) — not wired to a route. Building a synchronous HTTP endpoint
    instead would just relocate the architecture violation this phase is
    explicitly trying to avoid. Wiring this to a real queue is this
    phase's main open item.

- **Phase 11** — audit system (read side). `AuditService.record()` has
  written every state-changing mutation's audit row since Phase 4; this
  phase adds the query/export side architecture §5 calls for:
  - `GET /audit-events` (`audit.read` permission, already granted to
    Auditor and Organization Admin since Phase 5): cursor-paginated
    (`?cursor=&limit=`, architecture §5's convention — fetches `limit + 1`
    rows to detect a next page without a separate `COUNT`), filterable by
    `actorId`/`action`/`resourceType`/`resourceId`/`dateFrom`/`dateTo`, all
    validated through a DTO (`QueryAuditEventsDto`) under the app's global
    `ValidationPipe`. `organizationId` is never a filter field — it only
    ever comes from the authenticated session, via
    `TenantPrismaService.forOrg()`, same as every other tenant-scoped read.
  - `GET /audit-events/export`: same filters, serialized as RFC 4180 CSV.
    Capped at 5,000 rows (`AUDIT_EXPORT_MAX_ROWS`) — no background-worker
    queue exists yet (the same gap Phase 10 flagged for payment execution),
    so this is a single synchronous HTTP response; past the cap it returns
    `413 Payload Too Large` with a message to narrow the filters, rather
    than silently truncating the file.
  - **Deliberately absent, on purpose**: any update or delete route.
    Architecture §10 calls audit rows append-only and explicitly defers
    full enforcement (a separate, more-privileged DB role for any future
    archival/retention job, with the application's own role holding only
    `INSERT`/`SELECT` on `audit_events`) as "out of scope for the
    prototype." This phase's job was the part of that guarantee a single
    DB role can't already provide — a service/controller surface with no
    write path but `record()` and no delete path at all — not the
    DB-role split, which was already a named, deferred item before this
    phase started.

- **Phase 12** — notifications. A `Notification` row per recipient
  (tenant-scoped, new migration `20250106000000_notifications`) with an
  email delivery status.
  - **API** (`SessionAuthGuard` only — everyone may read their own inbox):
    `GET /notifications` (cursor-paginated, `?unreadOnly=true`),
    `GET /notifications/unread-count`, `POST /notifications/:id/read`,
    `POST /notifications/read-all`. There is no `userId` parameter
    anywhere: every query filters on the session's user, so someone
    else's notification id returns 404, indistinguishable from a missing
    one (no IDOR).
  - **Email** goes through an `EmailProvider` abstraction (architecture
    decision #9; SMS/push are interfaces only). `notify()` never sends
    inline — it marks the row `PENDING`, and `dispatchPendingEmails()`
    drains them through the provider. Like Phase 10's payment execution,
    that is **deliberately not exposed over HTTP** (architecture §3:
    workers own email) and waits on the same missing queue layer. The
    shipped provider is a mock that logs recipient + subject, never the
    body. A failed send is marked `FAILED`, not retried forever.
  - **Wiring**: `ApprovalsService` notifies the payment's creator when it
    is finalized as approved or rejected (not on partial N-of-M progress).
    Sent after the transaction commits and best-effort — a notification
    failure can never undo or fail an approval. Other triggers (payment
    executed/failed, beneficiary verified, invites) are not wired yet.

Scheduled one-off payments (`Payment.scheduledFor`), the admin portal, and
the frontends are not yet built (Phases 13+).

> **Note on Phase 7's origin:** most of `BeneficiariesService`, its DTOs,
> and the schema/migration adding `createdByUserId`/`verifiedByUserId`/
> `rejectionReason` were found already present in the workspace at the
> start of this phase, not written in that conversation turn. They were
> reviewed with the same scrutiny as original work before being accepted:
> the migration chain was applied end-to-end against live Postgres, the FK
> constraints on the new columns were confirmed to actually reject
> dangling references, and the account-number masking logic was found to
> **fully expose** account numbers at the DTO's minimum length (4
> characters) due to a bug in the original masking function — fixed, and
> covered by a regression test (`beneficiaries.service.spec.ts`,
> "fully masks an account number at the DTO minimum length"). The
> controller and module wiring (`beneficiaries.controller.ts`, the
> `BeneficiariesModule` providers list) did not exist yet and were written
> fresh to complete the module.

> **Note on Phase 8's origin:** similarly, `payment-state-machine.ts`,
> `create-payment.dto.ts`, the `beneficiaries.read` permission (closing a
> gap flagged in Phase 7), and the default `ApprovalPolicy` provisioning in
> `OrganizationsService` were already present at the start of this phase.
> Reviewed the same way: the state machine was checked transition-by-
> transition against architecture §8 and given full positive/negative test
> coverage (`payment-state-machine.spec.ts`, 28 cases), and the migration
> chain plus new-org default policy were verified against live Postgres.
> No bugs found this time. `PaymentsService`, `PaymentsController`, and the
> module wiring did not exist yet and were written fresh.

> **Note on Phase 9's environment:** this phase started from a fresh
> container with `node_modules` absent entirely (`pnpm install` was rerun
> from scratch — same `binaries.prisma.sh` 403 as every prior phase, no
> change there). No stray or unexpected pre-existing content this time —
> `apps/api/src/modules/approvals/` held only the Phase 2 module stub, and
> the schema already had everything Phase 9 needed (`PaymentApproval`,
> `ApprovalDecision`, `ApprovalPolicy.requiredApprovals`/
> `makerCanApproveOwn`) from Phase 3/6, unchanged — so no new migration.
> One incidental, unrelated fix: `apps/api/tsconfig.json`'s
> `ignoreDeprecations: "6.0"` doesn't parse under the TypeScript version
> this fresh install resolved (5.7.2, vs. whatever earlier phases ran
> against) — `tsc` refused to start at all. Changed to `"5.0"`, the value
> that version accepts for the same baseUrl-without-paths deprecation it
> was already silencing.

> **Note on Phase 10's origin:** another fresh container — `node_modules`
> had to be reinstalled again, same `binaries.prisma.sh` block as every
> prior phase. This time `apps/api/src/modules/ledger/` had real
> unexpected content at the start: `ReconciliationService`,
> `LedgerController` (`POST /ledger/reconcile`), their mocked-Prisma and
> integration specs, and the `ledger.reconcile` permission (added to
> Organization Admin and Finance Manager) — the entire reconciliation half
> of this phase. Reviewed with the same scrutiny as everything else:
> checked the computed-balance SQL against the real `ledger_entries`
> schema and column names, confirmed the "detect, never auto-correct"
> design matches architecture §9's own description, and ran its 4 unit
> tests for real (all passed, no bugs found) alongside a live-Postgres
> smoke test of the drift-detection path. Payment execution — the other
> half of this phase (`PaymentExecutionService`, `MockPaymentProviderService`,
> the `AccountPurpose`/`SETTLEMENT` account split and its migration) — did
> not exist yet and was written fresh.

> **Note on Phase 12's test setup:** `jest.config.js` now detects when no
> generated Prisma client exists and, only then, stubs `@prisma/client`
> and turns off ts-jest type diagnostics, so the mocked-Prisma unit specs
> run even where `binaries.prisma.sh` is blocked. This restored the six
> suites Phase 11 found unrunnable (**125 passing across 13 suites** now).
> With a real generated client nothing changes: full type-checking, no
> stub. Trade-off: in a stubbed environment the specs no longer
> type-check against the schema, so run `tsc` and the integration suites
> somewhere with network access before trusting a build. The new
> migration was applied after all earlier ones on live Postgres: the
> table, defaults and both foreign keys behave (dangling user/org ids are
> rejected).

> **Note on Phase 11's environment:** no pre-existing audit-read code was
> found this time — `AuditController`, the query DTO, the CSV util, and
> `AuditService.queryEvents()`/`queryEventsForExport()` were all written
> fresh. This phase's own compile check caught a real bug in that new code,
> not an environment issue: `AuditService.record()` imported `Prisma`/
> `PrismaClient` as named types directly from `@prisma/client`, which every
> other service in this codebase deliberately avoids (see `ledger.service.ts`'s
> `$transaction` callback, typed `any` for the same reason) — in a container
> with no generated Prisma client at all, that import fails even as a
> type-only import, not just at runtime. Fixed by typing the transaction
> handle `any`, same convention as everywhere else. Once fixed,
> `audit.service.spec.ts` (10 cases: `record`'s tx-vs-raw-client routing,
> `queryEvents`'s filters/cursor/pagination/the `organizationId` field never
> being accepted as a filter, `queryEventsForExport`'s cap and 413) and
> `audit-csv.util.spec.ts` (5 cases: header row, null-vs-literal-"null"
> handling, RFC 4180 quoting, JSON-serializing object fields, the
> empty-list case) all pass. This container's `@prisma/client` has no
> generated output whatsoever — not even the partial type stub prior phases
> relied on for their `tsc`/`ts-jest` passes against `PrismaService`-backed
> code (`npx prisma generate --no-engine` still needs to fetch
> `schema-engine.gz` from the blocked `binaries.prisma.sh`, so even that
> flag doesn't get around it) — so the pre-existing mocked-Prisma suites
> that worked in Phases 9/10 (`approvals.service.spec.ts`,
> `ledger.service.spec.ts`, `payments.service.spec.ts`,
> `beneficiaries.service.spec.ts`, `reconciliation.service.spec.ts`,
> `payment-execution.service.spec.ts`) currently fail to even run here, on
> the same property-access-against-the-real-schema type errors shown
> throughout this note — a strictly worse instance of the same
> long-standing `binaries.prisma.sh` block, not a regression introduced by
> this phase's code. Confirm against an environment with real network
> access before trusting any of those suites' current red state.

## Stack

- **Backend:** NestJS (TypeScript), PostgreSQL via Prisma, Redis, BullMQ
- **Frontend:** Next.js, React, TypeScript, Tailwind CSS
- **Monorepo:** pnpm workspaces + Turborepo

## Getting started (once dependencies are installed)

```bash
cp .env.example .env
pnpm install
docker compose -f infra/docker-compose.yml up -d postgres redis mailhog
pnpm --filter @cbp/api prisma:generate
pnpm --filter @cbp/api prisma:migrate   # or apply prisma/migrations/*/migration.sql directly
pnpm --filter @cbp/api prisma:seed
pnpm dev
```

- API: http://localhost:4000 (Swagger docs at `/api/docs`)
- Web dashboard: http://localhost:3000
- Admin portal: http://localhost:3001

## Testing

```bash
pnpm --filter @cbp/api test               # unit tests — no DB required
pnpm --filter @cbp/api test:integration   # requires DATABASE_URL + a real generated Prisma client
```

> **Note on this repo's history:** the sandbox this was built in blocks
> `binaries.prisma.sh`, so `prisma generate`/`migrate`/`validate` could not
> run there. Schema and migration SQL were instead validated by applying the
> SQL directly to a live Postgres instance and running hand-written smoke
> tests in raw SQL (see the Phase 3, 4, 6, 7, 8, 9, and 10 write-ups —
> Phase 6 verified the double-entry ledger-posting pattern and idempotency;
> Phase 7 verified the beneficiary FK constraints; Phase 8 verified payment
> creation, submission, approval-policy resolution, and idempotency;
> Phase 9 verified the N-of-M approval lifecycle, the
> `payment_approvals`/`paymentId`+`approverUserId` unique constraint as a
> DB-level backstop against a duplicate decision, and FK integrity on
> `payment_approvals.paymentId`; Phase 10 verified the `AccountPurpose`
> partial unique index — one `SETTLEMENT` account per org+currency, no cap
> on `CUSTOMER` accounts — and the full execution path end-to-end: a
> payment moving APPROVED → PROCESSING → COMPLETED, its source/settlement
> account balances updating correctly, the double-entry netting to zero,
> and `LedgerEntryGroup.paymentId`'s unique constraint rejecting a second
> execution attempt at the DB level). Unit tests that don't touch Prisma —
> either pure logic (password hashing, TOTP, challenge tokens, the payment
> state machine's full transition table, CSV serialization) or a service
> exercised with mocked Prisma/Audit dependencies (`BeneficiariesService`,
> `PaymentsService`, `ApprovalsService`, `ReconciliationService`,
> `PaymentExecutionService`, `LedgerService.getOrCreateSettlementAccount`,
> and, new in Phase 11, `AuditService`) were run for real against prior
> containers with a usable type stub: **95 passing** as of Phase 10. As of
> Phase 11, this container's `@prisma/client` has no generated output at
> all (see that phase's environment note above), so only the suites with
> no transitive dependency on `PrismaService`'s generated model types
> currently run here: **54 passing** (`password.service.spec.ts`,
> `challenge-token.service.spec.ts`, `totp.service.spec.ts`,
> `payment-state-machine.spec.ts`, `audit-csv.util.spec.ts`, and
> `audit.service.spec.ts`'s 10 new cases, once its one real bug — described
> above — was fixed). The suites that worked in Phases 9/10
> (`approvals.service.spec.ts`, `ledger.service.spec.ts`,
> `payments.service.spec.ts`, `beneficiaries.service.spec.ts`,
> `reconciliation.service.spec.ts`, `payment-execution.service.spec.ts`)
> are unchanged and believed still correct, but need a container with a
> real (or at least partially-generated) Prisma client to confirm. The
> integration test suites (`test:integration`:
> `tenant-scope.extension.integration.spec.ts`,
> `organizations-users.integration.spec.ts`,
> `ledger.service.integration.spec.ts`, `beneficiaries.integration.spec.ts`,
> `payments.integration.spec.ts`, `approvals.integration.spec.ts`,
> `reconciliation.service.integration.spec.ts`) are written, confirmed to
> compile cleanly in prior containers, and confirmed to fail only at Prisma
> client initialization in this sandbox — but need a real generated Prisma
> client to actually run. Run everything in an environment with normal
> network access before trusting this in CI.

## Project structure

```
apps/
  api/        NestJS backend — one module per domain (auth, accounts, payments, ledger, audit, ...)
  web/        Corporate customer dashboard (Next.js)
  admin/      Internal admin portal (Next.js)
packages/
  shared-types/  DTOs/enums shared between API and frontends
  ui/            Shared accessible component library
infra/
  docker-compose.yml   Local dev services (Postgres, Redis, Mailhog, api, web)
docs/architecture/     Architecture, ER diagram, schema, and phased plan
```

## Development phases

See `docs/architecture/phase1-architecture.md` §14. Each phase is implemented,
tested, and explicitly approved before the next begins.
