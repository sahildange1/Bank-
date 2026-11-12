import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as cookieParser from 'cookie-parser';
import { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { originCheck } from './common/middleware/origin-check.middleware';
import { requestContext } from './common/middleware/request-context.middleware';

export function allowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.CORS_ORIGIN ?? '').split(',').map((o) => o.trim()).filter(Boolean);
}

/**
 * Everything that must be identical in production and in tests lives here:
 * main.ts and the e2e suite both call it, so the hardening below is what the
 * tests actually exercise (previously the e2e suite re-declared a subset).
 */
export function configureApp(app: INestApplication, env: NodeJS.ProcessEnv = process.env): void {
  const production = env.NODE_ENV === 'production';
  const origins = allowedOrigins(env);

  // Behind a load balancer every client shares its IP, which would collapse
  // per-IP rate limits (and let X-Forwarded-For be spoofed if trusted blindly).
  // Off unless an explicit hop count is configured.
  const hops = env.TRUST_PROXY ? Number(env.TRUST_PROXY) : 0;
  (app.getHttpAdapter().getInstance() as { set: (k: string, v: unknown) => void }).set('trust proxy', hops);

  app.use(requestContext());
  app.use(
    helmet({
      // A JSON API never needs to be framed, scripted or load subresources.
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      referrerPolicy: { policy: 'no-referrer' },
      hsts: production ? { maxAge: 63_072_000, includeSubDomains: true } : false,
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  // Responses carry financial data and per-user state: never cache them.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(cookieParser());
  app.use(originCheck(origins));
  app.enableCors({ origin: origins, credentials: true });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
}
