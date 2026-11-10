import { ForbiddenException } from '@nestjs/common';
import { PlatformOperatorGuard } from './platform-operator.guard';

describe('PlatformOperatorGuard', () => {
  function run(opts: { org?: any; mfa?: any; auth?: any }) {
    const prisma = {
      organization: { findUnique: jest.fn().mockResolvedValue(opts.org ?? null) },
      mfaFactor: { findFirst: jest.fn().mockResolvedValue(opts.mfa ?? null) },
    };
    const guard = new PlatformOperatorGuard(prisma as any);
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({ authContext: 'auth' in opts ? opts.auth : { userId: 'u1', organizationId: 'o1' } }),
      }),
    };
    return { prisma, result: guard.canActivate(ctx as any) };
  }

  it('allows an active platform org user with verified MFA', async () => {
    const { result } = run({ org: { isPlatform: true, status: 'ACTIVE' }, mfa: { id: 'm' } });
    await expect(result).resolves.toBe(true);
  });

  it('denies a customer-organization user even if they hold platform permissions', async () => {
    const { result } = run({ org: { isPlatform: false, status: 'ACTIVE' }, mfa: { id: 'm' } });
    await expect(result).rejects.toThrow(ForbiddenException);
  });

  it('denies when the platform org is not ACTIVE', async () => {
    const { result } = run({ org: { isPlatform: true, status: 'SUSPENDED' }, mfa: { id: 'm' } });
    await expect(result).rejects.toThrow(ForbiddenException);
  });

  it('denies a platform user with no verified MFA factor', async () => {
    const { prisma, result } = run({ org: { isPlatform: true, status: 'ACTIVE' }, mfa: null });
    await expect(result).rejects.toThrow(/Multi-factor/);
    expect(prisma.mfaFactor.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'u1', verified: true } }),
    );
  });

  it('denies when no auth context was attached (guard misordering fails closed)', async () => {
    const { result } = run({ auth: undefined });
    await expect(result).rejects.toThrow(ForbiddenException);
  });
});
