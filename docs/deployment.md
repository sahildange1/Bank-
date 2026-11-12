# Deployment runbook (sandbox platform)

This is a **sandbox**: the payment provider is a mock and no real money moves. The
steps below produce a production-shaped deployment; they are not a claim of
regulatory or compliance readiness.

## Components
| Service | Image target | Notes |
|---|---|---|
| `postgres` | `postgres:16-alpine` | No published port. Back it up yourself (below). |
| `migrate` | api image | One-shot `prisma migrate deploy`; API/worker wait for it to succeed. |
| `api` | `api.prod.Dockerfile` | Non-root, read-only FS, `/health/live`, `/health/ready`. |
| `worker` | same image, `node dist/worker.js` | Email outbox dispatch + hourly ledger reconciliation. **Run exactly one replica.** |
| `web`, `admin` | `next.prod.Dockerfile` | Next standalone. `PUBLIC_API_URL` is baked in at build time. |

TLS termination, DNS, and a reverse proxy are **not** included: put one in front and set
`TRUST_PROXY` to the number of proxy hops. Ports bind to 127.0.0.1 by design.

## First deployment
1. `cp infra/prod.env.example prod.env`; fill every value (`openssl rand -base64 48`). Keep it out of git;
   store secrets in your platform's secret manager. `MFA_ENCRYPTION_KEY` must differ from `JWT_ACCESS_SECRET`.
2. `docker compose -f infra/docker-compose.prod.yml --env-file prod.env up -d --build`
   The API refuses to start on a weak/placeholder secret, non-https CORS origin, or dev flags
   (see `env.validation.ts`); read `docker compose logs api` if it exits.
3. Seed permissions and the platform organization (one-off job on the toolchain image, which includes `ts-node`):
   ```
   docker build -f infra/docker/api.prod.Dockerfile --target tools -t cbp-tools .
   docker run --rm --network cbp_default -e DATABASE_URL='postgresql://cbp:<password>@postgres:5432/corporate_banking?schema=public' \
     cbp-tools pnpm prisma:seed
   ```
4. Create the first platform operator with `prisma/create-platform-operator.ts` the same way (`pnpm exec ts-node prisma/create-platform-operator.ts`), then enroll MFA
   at first login (platform operators require a verified factor).

## Upgrades
`git pull && docker compose ... up -d --build`. Migrations run before the new API starts. Migrations
are forward-only: take a database backup first, and write schema changes expand/contract so the previous
image keeps working while the new one rolls out.

## Rollback
Redeploy the previous image tag. If a migration must be undone, restore the pre-upgrade backup — there
are no automatic down-migrations.

## Backups
`docker compose exec postgres pg_dump -U cbp -Fc corporate_banking > backup-$(date +%F).dump`
Test a restore into a scratch database regularly. Audit events are append-only in the application, but
only a restricted database role (not provided in this sandbox) would enforce that at the database level.

## Health and monitoring
- `GET /health/live` — process up. `GET /health/ready` — database reachable (503 otherwise, no detail).
- API access logs and worker job logs are JSON lines on stdout with request ids; ship them to your log store.
- Ledger reconciliation results are recorded as audit events; alert on drift.

## Known limits
- Worker is single-instance; payment execution is not auto-scheduled (needs an acting user — decide deliberately).
- Rate limiting is per API instance, not shared.
- No object storage, SMTP, or Redis is wired in the production compose file (mock email provider only).
