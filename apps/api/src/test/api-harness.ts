import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
// Namespace import on purpose: tsconfig has no esModuleInterop, so a default import
// of this CommonJS module is undefined at runtime and the API would crash on boot.
import * as cookieParser from 'cookie-parser';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter';
import { BigIntSerializerInterceptor } from '../common/interceptors/bigint-serializer.interceptor';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { SessionAuthGuard } from '../common/guards/session-auth.guard';
import { PrismaService } from '../common/prisma/prisma.service';
import { PlatformOperatorGuard } from '../modules/admin/guards/platform-operator.guard';
import { SessionService } from '../modules/auth/services/session.service';

/**
 * HTTP-level test harness. It boots REAL controllers with the REAL guards
 * (SessionAuthGuard, PermissionsGuard, PlatformOperatorGuard), the REAL
 * global ValidationPipe settings from main.ts and the REAL exception
 * filter — so wiring, guard order, DTO validation, status codes and the
 * error envelope are exercised over actual HTTP via supertest. Only the
 * data layer is faked: sessions and users come from `users` below, and
 * services are mocks supplied by the caller.
 *
 * What this deliberately does NOT cover: SQL, transactions, tenant-scope
 * extension behaviour. Those need a real database and are covered by the
 * integration suites and test/e2e (run in CI, see .github/workflows/ci.yml).
 */
export interface FakeUser {
  id: string;
  organizationId: string;
  permissions: string[];
  orgStatus?: 'ACTIVE' | 'PENDING' | 'SUSPENDED' | 'CLOSED';
  orgIsPlatform?: boolean;
  hasVerifiedMfa?: boolean;
}

/** The session cookie value is simply the key into this map. */
export type FakeUsers = Record<string, FakeUser>;

export async function createApiApp(opts: {
  controllers: any[];
  providers: any[];
  users: FakeUsers;
}): Promise<INestApplication> {
  const byUserId = (id: string) => Object.values(opts.users).find((u) => u.id === id);
  const byOrgId = (id: string) => Object.values(opts.users).find((u) => u.organizationId === id);

  const sessionService = {
    validateAndTouch: async (sessionId: string) =>
      opts.users[sessionId]
        ? { id: sessionId, userId: opts.users[sessionId].id, expiresAt: new Date(Date.now() + 60_000) }
        : null,
  };

  const prisma = {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const u = byUserId(where.id);
        if (!u) return null;
        return {
          id: u.id,
          organizationId: u.organizationId,
          status: 'ACTIVE',
          organization: { status: u.orgStatus ?? 'ACTIVE' },
          userRoles: [
            { role: { rolePermissions: u.permissions.map((key) => ({ permission: { key } })) } },
          ],
        };
      },
    },
    organization: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const u = byOrgId(where.id);
        return u ? { isPlatform: !!u.orgIsPlatform, status: u.orgStatus ?? 'ACTIVE' } : null;
      },
    },
    mfaFactor: {
      findFirst: async ({ where }: { where: { userId: string } }) =>
        byUserId(where.userId)?.hasVerifiedMfa ? { id: 'mfa-1' } : null,
    },
  };

  const moduleRef = await Test.createTestingModule({
    controllers: opts.controllers,
    providers: [
      SessionAuthGuard,
      PermissionsGuard,
      PlatformOperatorGuard,
      { provide: SessionService, useValue: sessionService },
      { provide: PrismaService, useValue: prisma },
      ...opts.providers,
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new BigIntSerializerInterceptor());
  await app.init();
  return app;
}

export const SESSION_COOKIE = 'cbp_session';
export const cookieFor = (key: string) => `${SESSION_COOKIE}=${key}`;
