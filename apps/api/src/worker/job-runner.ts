export interface Job {
  name: string;
  intervalMs: number;
  run: () => Promise<unknown>;
}

export type JobLog = (line: Record<string, unknown>) => void;

export interface JobRunner {
  /** Stops scheduling and resolves once any in-flight job has finished. */
  stop(): Promise<void>;
}

/**
 * Minimal in-process scheduler for the worker. Guarantees: a job never
 * overlaps itself (a slow run delays the next one instead of stacking), one
 * job's failure never stops the others or the loop, and stop() drains
 * in-flight work so a SIGTERM doesn't cut a job off mid-transaction.
 * Errors are logged by message only, never the thrown object (it may carry
 * query parameters).
 */
export function startJobs(
  jobs: Job[],
  log: JobLog = (l) => process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...l }) + '\n'),
): JobRunner {
  const inFlight = new Set<Promise<void>>();
  const running = new Set<string>();
  let stopped = false;

  const tick = (job: Job) => {
    if (stopped || running.has(job.name)) return;
    running.add(job.name);
    const p = (async () => {
      try {
        const result = await job.run();
        log({ level: 'info', msg: 'job ok', job: job.name, result });
      } catch (e) {
        log({ level: 'error', msg: 'job failed', job: job.name, error: e instanceof Error ? e.message : 'unknown' });
      } finally {
        running.delete(job.name);
      }
    })();
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
  };

  const timers = jobs.map((job) => {
    if (!Number.isFinite(job.intervalMs) || job.intervalMs < 1000) {
      throw new Error(`Job ${job.name}: intervalMs must be >= 1000`);
    }
    tick(job);
    return setInterval(() => tick(job), job.intervalMs);
  });

  return {
    async stop() {
      stopped = true;
      timers.forEach(clearInterval);
      await Promise.allSettled([...inFlight]);
    },
  };
}
