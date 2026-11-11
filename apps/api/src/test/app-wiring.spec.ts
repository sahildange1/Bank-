import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AppModule } from '../app.module';
import { PrismaService } from '../common/prisma/prisma.service';

/**
 * Dependency-injection smoke test: resolves the REAL AppModule graph (every
 * module, controller, guard and provider) with only the database client
 * replaced, so no database is needed. Unit tests that build their own small
 * modules can't catch a missing import/export between real modules — this
 * one exists because exactly that bug let the API ship unable to start
 * (SessionAuthGuard could not resolve SessionService) through several phases.
 */
describe('AppModule wiring', () => {
  it('resolves the whole dependency graph (the API can boot)', async () => {
    process.env.JWT_ACCESS_SECRET ??= 'unit-test-jwt-secret-0123456789abcdef012345';
    process.env.MFA_ENCRYPTION_KEY ??= 'unit-test-mfa-key-0123456789abcdef012345';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({ $connect: async () => undefined, $disconnect: async () => undefined, $extends: () => ({}) })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  });
});
