# Corporate Banking Platform (Sandbox)

A prototype corporate banking platform — multi-tenant, maker-checker payment
approvals, double-entry ledger, immutable audit trail. **No real money
movement**: payments run against a mock/sandbox provider.

See `docs/architecture/phase1-architecture.md` for the full architecture,
data model, and phased implementation plan.

## Status

Phases 1–10 of the phased plan (`docs/architecture/phase1-architecture.md`
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

Scheduled one-off payments (`Payment.scheduledFor`), notifications, the
admin portal, and the frontends are not yet built (Phases 11+).

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
> state machine's full transition table) or a service exercised with
> mocked Prisma/Audit dependencies (`BeneficiariesService`,
> `PaymentsService`, `ApprovalsService`, `ReconciliationService`,
> `PaymentExecutionService`, and `LedgerService.getOrCreateSettlementAccount`)
> — were run for real: **95 passing** as of Phase 10. The integration test
> suites (`test:integration`: `tenant-scope.extension.integration.spec.ts`,
> `organizations-users.integration.spec.ts`,
> `ledger.service.integration.spec.ts`, `beneficiaries.integration.spec.ts`,
> `payments.integration.spec.ts`, `approvals.integration.spec.ts`,
> `reconciliation.service.integration.spec.ts`) are written, confirmed to
> compile cleanly, and confirmed to fail only at Prisma client
> initialization in this sandbox — but need a real generated Prisma client
> to actually run. Run them in an environment with normal network access
> before trusting this in CI.

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
