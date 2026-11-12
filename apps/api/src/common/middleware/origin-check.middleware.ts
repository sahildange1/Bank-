import { NextFunction, Request, Response } from 'express';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF defense in depth. The session cookie is already SameSite=Strict and
 * httpOnly, so a cross-site page can't make the browser attach it. This adds
 * a second, independent layer: any state-changing request that carries an
 * Origin (or, failing that, a Referer) must come from an allowed origin,
 * otherwise 403 — before any guard or handler runs.
 *
 * Requests with neither header (curl, server-to-server, tests) pass: they
 * aren't browser-driven, so there is no ambient cookie to ride on. Browsers
 * always send Origin on cross-origin unsafe requests.
 */
export function originCheck(allowedOrigins: readonly string[]) {
  const allowed = new Set(allowedOrigins.map((o) => o.replace(/\/$/, '')));
  const reject = (res: Response) =>
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Cross-origin request blocked.' } });

  return (req: Request, res: Response, next: NextFunction) => {
    if (!UNSAFE_METHODS.has(req.method)) return next();

    const origin = req.headers.origin;
    if (origin !== undefined) {
      return typeof origin === 'string' && allowed.has(origin) ? next() : reject(res);
    }
    const referer = req.headers.referer;
    if (referer !== undefined) {
      try {
        const refererOrigin = new URL(String(referer)).origin;
        return allowed.has(refererOrigin) ? next() : reject(res);
      } catch {
        return reject(res);
      }
    }
    return next();
  };
}
