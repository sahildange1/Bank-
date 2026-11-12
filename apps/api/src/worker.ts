import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { assertValidEnvironment } from './common/config/env.validation';
import { NotificationsService } from './modules/notifications/services/notifications.service';
import { ReconciliationService } from './modules/ledger/services/reconciliation.service';
import { startJobs } from './worker/job-runner';

const ms = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 1000 ? v : fallback;
};

/**
 * Background worker: a Nest application context (no HTTP listener) running
 * the jobs that architecture §3 reserves for workers. Run EXACTLY ONE replica
 * — the jobs are not yet claimed with row locks, so two workers could both
 * deliver the same pending email. Payment execution is intentionally not
 * scheduled here: it needs an acting user for its audit trail, and
 * auto-executing money movement is a decision for the operator, not a default.
 */
async function bootstrap() {
  assertValidEnvironment();
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const notifications = app.get(NotificationsService);
  const reconciliation = app.get(ReconciliationService);

  const runner = startJobs([
    { name: 'dispatch-emails', intervalMs: ms('WORKER_EMAIL_INTERVAL_MS', 15_000), run: () => notifications.dispatchPendingEmails() },
    {
      name: 'reconcile-ledger',
      intervalMs: ms('WORKER_RECONCILE_INTERVAL_MS', 3_600_000),
      run: async () => {
        const reports = await reconciliation.reconcileAllOrganizations();
        return { organizations: reports.length };
      },
    },
  ]);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await runner.stop();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

bootstrap().catch((e) => {
  process.stderr.write(`worker failed to start: ${e instanceof Error ? e.message : 'unknown'}\n`);
  process.exit(1);
});
