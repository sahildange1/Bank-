# Corporate Banking Platform (Sandbox)

A prototype corporate banking platform — multi-tenant, maker-checker payment
approvals, double-entry ledger, immutable audit trail. **No real money
movement**: payments run against a mock/sandbox provider.

See `docs/architecture/phase1-architecture.md` for the full architecture,
data model, and phased implementation plan.

## Status

Phases 1–14 of the phased plan (`docs/architecture/phase1-architecture.md`
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

- **Phase 13** — admin portal (backend + `apps/admin` UI). Bank staff
  ("platform operators") act across all customer organizations, which
  nothing in the earlier phases modelled, so this phase added it:
  - **Operator model:** a single internal *platform organization*
    (`Organization.isPlatform`, at most one — enforced by a partial unique
    index, migration `20250107000000_platform_organization`) whose users
    hold a `Platform Operator` role with four new `platform.*`
    permissions. These are kept out of the customer `PERMISSIONS` list, so
    the *Organization Admin* template (which grants every customer
    permission) can never include them. Login, MFA, sessions and RBAC are
    reused; no second auth system.
  - **Access** to `/admin/*` needs all of: a valid session
    (`SessionAuthGuard`), membership of the ACTIVE platform organization
    and a **verified MFA factor** (`PlatformOperatorGuard`, checked live in
    the database), and the specific `platform.*` permission. A permission
    granted by mistake inside a customer org is therefore inert, and an
    operator without MFA is refused until they enroll.
  - **Endpoints:** `GET /admin/organizations` (status/name filter, cursor
    pagination) and `/:id`; `POST /admin/organizations/:id/{approve,
    suspend,reactivate,close}`; `GET /admin/stats`; `GET /admin/audit-events`
    (all organizations, optional `organizationId` filter that exists only on
    this path). Lifecycle: PENDING→ACTIVE (approve); ACTIVE→SUSPENDED;
    SUSPENDED→ACTIVE; PENDING/ACTIVE/SUSPENDED→CLOSED (terminal; closing a
    PENDING org is how an application is rejected). Suspend and close
    require a written reason.
  - **Safety:** each change is a compare-and-set on the validated status
    inside one transaction with its audit row (two operators racing get a
    409, not two transitions); suspend/close revoke every live session of
    that organization in the same transaction, and `SessionAuthGuard` now
    also rejects any session whose organization is not ACTIVE. The platform
    organization itself can't be changed through the API. Reading the
    cross-organization audit trail is itself written to the audit trail.
    Approval notifies the organization's admins (Phase 12).
  - **Bootstrapping** (no secrets in source): `prisma db seed` creates the
    permissions, platform org and role; then
    `PLATFORM_OPERATOR_EMAIL=… PLATFORM_OPERATOR_PASSWORD=… pnpm --filter
    @cbp/api exec ts-node prisma/create-platform-operator.ts` creates the
    first operator, who must sign in and enroll MFA via the API
    (`/auth/mfa/enroll/*`; there is no MFA-enrollment screen yet).
  - **UI** (`apps/admin`, Next.js): sign-in with MFA step, platform stats
    dashboard, organizations table with approve/suspend/reactivate/close
    (reason dialog), and a cross-organization audit view. Hiding nav/buttons
    is cosmetic; the API enforces every permission. The session cookie is
    `SameSite=Strict`, so the admin app and API must share a site (fine on
    `localhost`; in production, put both behind one domain). The admin
    portal is intentionally **not** deployed to GitHub Pages.
  - **Not covered:** the security-events and per-organization limits
    screens mentioned in architecture §16, organization detail/user
    management screens, an MFA-enrollment UI, and a customer-facing
    "your application was rejected/closed" notification. I could not run the
    API or the UI against a live server in this sandbox (no generated Prisma
    client), so the endpoints are covered by mocked-Prisma unit tests and
    the migration by raw SQL on live Postgres — not by an end-to-end run.

- **Phase 14** — testing and the CI gate. The headline result: **CI
  (`.github/workflows/ci.yml`) now runs the whole suite on every push
  against a real generated Prisma client and a real Postgres**, which no
  earlier phase could do in the build sandbox. Its first run found real
  defects that mocked tests had hidden for several phases, all fixed here:
  - the API **could not start**: `GuardsModule` didn't re-export
    `AuthModule`, so `SessionAuthGuard` couldn't resolve `SessionService`
    in any feature module (now covered by `src/test/app-wiring.spec.ts`,
    which resolves the real `AppModule` graph with no database);
  - `main.ts` default-imported `cookie-parser` with no `esModuleInterop`,
    which is `undefined` at runtime (second boot crash);
  - every response containing a money column (`BigInt`) would have thrown
    during JSON serialization; a `BigIntSerializerInterceptor` now returns
    exact decimal strings;
  - 4 tenant-scoped `create` calls didn't type-check against the schema
    (first real `tsc` run); and 3 of 7 integration suites had never run
    (stale DI providers, a fake audit actor that violated a foreign key,
    teardown in the wrong order).
  - Behavior change: **self-signup now creates `PENDING` organizations**
    (architecture decision #2). Before this, signup activated instantly and
    Phase 13's approve action had nothing to do.
  - New tests: a route-guard sweep (every route of every controller must
    require a session and a declared permission unless explicitly
    allow-listed — a new unguarded route fails the build); HTTP-level
    supertest suites using the real guards, validation pipe and error
    filter; `PermissionsGuard`/`SessionAuthGuard` specs; and a real-database
    end-to-end journey (`apps/api/test/maker-checker.e2e-spec.ts`): signup →
    operator approval → maker/checker payment → audit → notifications →
    suspension, with the negative cases from §16 (cross-organization access,
    maker approving own payment, duplicate submission, invalid transitions).
  - **CI status when this phase landed:** typecheck, 296 unit/HTTP tests,
    27 integration tests and 5 e2e tests all pass; web and admin build.
  - **Not done, on purpose or by necessity:** (1) *"limit exceeded"* is in
    the §16 negative list but **per-payment/daily limits don't exist yet**
    (no model, no enforcement), so there is nothing to test — it needs a
    feature phase first; (2) **browser E2E (Playwright)** isn't written
    because the customer web app is still a placeholder; only the admin
    screens exist, and they were type-checked and built, not driven;
    (3) the e2e disables only the rate limiter (≈100 requests from one IP
    would trip it), so rate-limit behavior itself is untested; (4) MFA
    enrollment in e2e is stood in by a database row — the TOTP code path is
    covered by unit tests only; (5) the invite token is still printed to the
    server log (`console.log` in `UsersService.inviteUser`, a Phase 5
    placeholder): a credential-equivalent in logs, to be replaced with email
    delivery before any real deployment.

Scheduled one-off payments (`Payment.scheduledFor`) and the customer-facing
web app are not yet built (Phase 15+).

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
> suites Phase 11 found unrunnable (**296 unit tests (23 suites), plus 27 integration and 5 e2e tests that run in CI** now).
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
