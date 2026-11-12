import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Unauthenticated probes for load balancers / orchestrators. They expose no
 * data: liveness says the process is up; readiness additionally proves the
 * database answers. Failure detail is deliberately not returned (it can leak
 * hostnames or driver errors) — it belongs in logs, not in a public response.
 */
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException('Not ready');
    }
    return { status: 'ok' };
  }
}
