import { originCheck } from './origin-check.middleware';
import { requestContext } from './request-context.middleware';

function run(mw: any, req: any) {
  const headers: Record<string, string> = {};
  const listeners: Record<string, () => void> = {};
  const res: any = {
    statusCode: 200,
    body: undefined,
    setHeader: (k: string, v: string) => (headers[k.toLowerCase()] = v),
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
    on: (e: string, f: () => void) => (listeners[e] = f),
  };
  const next = jest.fn();
  mw({ method: 'GET', headers: {}, originalUrl: '/x', ...req }, res, next);
  return { res, headers, next, finish: () => listeners.finish?.() };
}

describe('originCheck', () => {
  const mw = originCheck(['https://app.example.com']);
  it('allows safe methods regardless of origin', () => {
    expect(run(mw, { method: 'GET', headers: { origin: 'https://evil.com' } }).next).toHaveBeenCalled();
  });
  it('rejects state-changing requests from a foreign Origin with 403', () => {
    const r = run(mw, { method: 'POST', headers: { origin: 'https://evil.com' } });
    expect(r.next).not.toHaveBeenCalled();
    expect(r.res.statusCode).toBe(403);
  });
  it('falls back to Referer when Origin is absent', () => {
    expect(run(mw, { method: 'DELETE', headers: { referer: 'https://evil.com/p' } }).res.statusCode).toBe(403);
    expect(run(mw, { method: 'DELETE', headers: { referer: 'https://app.example.com/p' } }).next).toHaveBeenCalled();
  });
  it('allows listed origins and non-browser clients without Origin/Referer', () => {
    expect(run(mw, { method: 'POST', headers: { origin: 'https://app.example.com' } }).next).toHaveBeenCalled();
    expect(run(mw, { method: 'POST', headers: {} }).next).toHaveBeenCalled();
  });
});

describe('requestContext', () => {
  it('generates an id and echoes it', () => {
    const r = run(requestContext(() => undefined), {});
    expect(r.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('honours a safe inbound id but replaces unsafe ones', () => {
    expect(run(requestContext(() => undefined), { headers: { 'x-request-id': 'abc-12345678' } }).headers['x-request-id']).toBe('abc-12345678');
    const bad = run(requestContext(() => undefined), { headers: { 'x-request-id': 'a\nb: injected' } });
    expect(bad.headers['x-request-id']).not.toContain('injected');
  });
  it('logs one JSON line without query string, body or cookies', () => {
    const lines: string[] = [];
    const r = run(requestContext((l) => lines.push(l)), {
      method: 'POST',
      originalUrl: '/auth/reset?token=SECRET',
      headers: { cookie: 'sid=SECRET2', authorization: 'Bearer SECRET3' },
      body: { password: 'SECRET4' },
    });
    r.finish();
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/SECRET/);
    expect(JSON.parse(lines[0])).toMatchObject({ method: 'POST', path: '/auth/reset', status: 200 });
  });
});
