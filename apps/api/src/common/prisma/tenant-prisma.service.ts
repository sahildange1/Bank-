import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { withTenantScope, ScopedPrismaClient } from './tenant-scope.extension';

/**
 * The only way a feature-module service should touch tenant-owned data.
 *
 * `forOrg(organizationId)` must always be called with the organizationId
 * from the authenticated session (see CurrentUser decorator / session
 * guard) — never from a request body, query param, or URL segment, or a
 * caller could simply pass another tenant's ID and bypass scoping entirely.
 */
@Injectable()
export class TenantPrismaService {
  constructor(private readonly prisma: PrismaService) {}

  forOrg(organizationId: string): ScopedPrismaClient {
    return withTenantScope(this.prisma, organizationId);
  }

  /**
   * Escape hatch for genuinely cross-tenant operations: the Admin module,
   * and background workers whose job is inherently org-spanning (e.g. the
   * scheduled-payment sweep, which must look across all organizations to
   * find due payments). Every call site using this must be reviewed —
   * grep for `.raw()` in code review to audit usage.
   */
  raw(): PrismaService {
    return this.prisma;
  }
}
