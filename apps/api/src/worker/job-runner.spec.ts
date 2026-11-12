import { startJobs } from './job-runner';

describe('startJobs', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  const quiet = () => undefined;

  it('runs immediately and then on every interval', async () => {
    const run = jest.fn().mockResolvedValue(1);
    const r = startJobs([{ name: 'a', intervalMs: 1000, run }], quiet);
    await jest.advanceTimersByTimeAsync(2000);
    expect(run).toHaveBeenCalledTimes(3);
    await r.stop();
  });

  it('never overlaps a job with itself', async () => {
    let release!: () => void;
    const run = jest.fn(() => new Promise<void>((res) => (release = res)));
    const r = startJobs([{ name: 'slow', intervalMs: 1000, run }], quiet);
    await jest.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await r.stop();
  });

  it('a failing job is logged (message only) and does not stop other jobs or its own schedule', async () => {
    const lines: Record<string, unknown>[] = [];
    const bad = jest.fn().mockRejectedValue(new Error('boom'));
    const good = jest.fn().mockResolvedValue(undefined);
    const r = startJobs(
      [
        { name: 'bad', intervalMs: 1000, run: bad },
        { name: 'good', intervalMs: 1000, run: good },
      ],
      (l) => lines.push(l),
    );
    await jest.advanceTimersByTimeAsync(1000);
    expect(bad).toHaveBeenCalledTimes(2);
    expect(good).toHaveBeenCalledTimes(2);
    expect(lines.find((l) => l.job === 'bad' && l.level === 'error')).toMatchObject({ error: 'boom' });
    await r.stop();
  });

  it('stop() prevents further runs and waits for in-flight work', async () => {
    let finished = false;
    let release!: () => void;
    const run = jest.fn(() => new Promise<void>((res) => (release = () => { finished = true; res(); })));
    const r = startJobs([{ name: 'a', intervalMs: 1000, run }], quiet);
    const stopping = r.stop();
    release();
    await stopping;
    expect(finished).toBe(true);
    await jest.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('rejects an interval under one second', () => {
    expect(() => startJobs([{ name: 'x', intervalMs: 10, run: async () => 1 }], quiet)).toThrow(/intervalMs/);
  });
});
