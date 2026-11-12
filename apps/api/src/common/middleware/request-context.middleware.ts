import * as crypto from 'crypto';
import { NextFunction, Request, Response } from 'express';

const SAFE_REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

export type LogSink = (line: string) => void;

/**
 * Gives every request an id (echoed as `x-request-id`, and used in the error
 * envelope so a user-reported id matches a server log line) and writes one
 * structured JSON access-log line per request.
 *
 * What is deliberately NOT logged: query strings (can carry tokens), request
 * or response bodies, headers and cookies (session ids, credentials). Only
 * the matched path, method, status, duration, request id and — once
 * authenticated — the user and organization ids.
 *
 * An inbound x-request-id is honoured only if it is short and made of safe
 * characters; otherwise it is replaced, so a caller can't inject newlines or
 * arbitrary text into logs.
 */
export function requestContext(sink: LogSink = (line) => process.stdout.write(line + '\n')) {
  return (req: Request, res: Response, next: NextFunction) => {
    const inbound = req.headers['x-request-id'];
    const requestId = typeof inbound === 'string' && SAFE_REQUEST_ID.test(inbound) ? inbound : crypto.randomUUID();
    (req as Request & { requestId?: string }).requestId = requestId;
    res.setHeader('x-request-id', requestId);

    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const auth = (req as Request & { authContext?: { userId: string; organizationId: string } }).authContext;
      sink(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: res.statusCode >= 500 ? 'error' : 'info',
          msg: 'request',
          requestId,
          method: req.method,
          path: (req.originalUrl ?? req.url).split('?')[0],
          status: res.statusCode,
          durationMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
          ...(auth ? { userId: auth.userId, organizationId: auth.organizationId } : {}),
        }),
      );
    });
    next();
  };
}
