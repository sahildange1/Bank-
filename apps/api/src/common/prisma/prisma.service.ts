import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Raw Prisma client wired into Nest's lifecycle. This is intentionally the
 * ONLY place in the codebase that should hold an unscoped client.
 *
 * Do not inject this directly into feature-module services that read or
 * write tenant-owned tables (Account, Payment, Beneficiary, etc.) — use
 * `TenantPrismaService.forOrg(organizationId)` instead (see
 * tenant-scope.extension.ts). This service exists so that:
 *   - Nest can manage connect/disconnect lifecycle in one place
 *   - Truly cross-tenant operations (the Admin module, background workers
 *     that legitimately operate across orgs) have an explicit, auditable
 *     escape hatch rather than every service being able to reach for it
 *     implicitly.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Connected to database');
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
