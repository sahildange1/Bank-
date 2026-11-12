import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('liveness never touches the database', () => {
    const prisma = { $queryRaw: jest.fn() };
    expect(new HealthController(prisma as any).live()).toEqual({ status: 'ok' });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
  it('readiness is ok when the database answers', async () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    await expect(new HealthController(prisma as any).ready()).resolves.toEqual({ status: 'ok' });
  });
  it('readiness returns 503 without leaking the underlying error', async () => {
    const prisma = { $queryRaw: jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432')) };
    const err = await new HealthController(prisma as any).ready().catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(JSON.stringify(err.getResponse())).not.toContain('10.0.0.5');
  });
});
