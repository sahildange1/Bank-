import { Injectable, PayloadTooLargeException } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { TenantPrismaService } from '../../../common/prisma/tenant-prisma.service';
import type { QueryAuditEventsDto } from '../dto/query-audit-events.dto';

// Typed as `any` rather than `Prisma.TransactionClient | PrismaClient`, same
// convention as ledger.service.ts's `$transaction` callback — this sandbox's
// network policy blocks `prisma generate`'s engine download (see Phase 3/4
// notes), so `Prisma`/`PrismaClient` aren't reliably importable as named
// types here. Once a real client is generated elsewhere, `tx` resolves to
// the proper Prisma.TransactionClient and callers don't need to change.
type PrismaTransactionLike = any;

// Prisma.InputJsonValue is intentionally not used here: it's absent from the
// minimal type stub Prisma falls back to when its engine binary can't be
// downloaded (this sandbox's network policy blocks binaries.prisma.sh — see
// Phase 3/4 notes). `Record<string, unknown> | undefined` is what we
// actually pass in, and is assignable to the real InputJsonValue type once
// a full client is generated, so this stays correct either way.
type JsonInput = Record<string, unknown> | undefined;

export interface AuditEventInput {
  organizationId?: string | null;
  actorId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  previousState?: Record<string, unknown> | null;
  newState?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Deliberate scope note: the full "Audit system" (query/filter APIs for the
 * Audit Logs screen, retention policy, export) is Phase 11 per the phased
 * plan. But architecture §10 requires that audit rows are written in the
 * same transaction as the change they describe, starting with the very
 * first state-changing endpoint — Authentication, this phase. Deferring
 * *recording* to Phase 11 would mean Phase 4–10 ship mutations with no
 * audit trail, which the brief explicitly rules out ("do not skip audit
 * events"). So this minimal `record()` method is implemented now; Phase 11
 * adds the read/query side on top of the same table.
 *
 * `record()` accepts an optional transaction client (`tx`) so callers can
 * pass their active `prisma.$transaction` handle and get atomicity with
 * the business mutation, per architecture §10. Never logs credentials.
 */
export interface QueryAuditEventsResult {
  events: Array<{
    id: string;
    organizationId: string | null;
    actorId: string | null;
    action: string;
    resourceType: string;
    resourceId: string | null;
    previousState: unknown;
    newState: unknown;
    metadata: unknown;
    ipAddress: string | null;
    userAgent: string | null;
    createdAt: Date;
  }>;
  nextCursor: string | null;
}

// Phase 11's own query ceiling for GET /audit-events/export — exporting is
// a single synchronous HTTP response (no background worker exists — see
// the Phase 10 write-up on why that's a recurring, deliberate gap in this
// codebase), so an unbounded export could hold a request open
// indefinitely on a large organization's history. A real deployment would
// move this to an async export job once that infra exists; for the
// sandbox, a hard cap with a clear error is the honest alternative to
// silently truncating the file with no indication anything was cut off.
export const AUDIT_EXPORT_MAX_ROWS = 5000;

/**
 * Deliberate scope note: the full "Audit system" (query/filter APIs for the
 * Audit Logs screen, retention policy, export) is Phase 11 per the phased
 * plan. But architecture §10 requires that audit rows are written in the
 * same transaction as the change they describe, starting with the very
 * first state-changing endpoint — Authentication, this phase. Deferring
 * *recording* to Phase 11 would mean Phase 4–10 ship mutations with no
 * audit trail, which the brief explicitly rules out ("do not skip audit
 * events"). So this minimal `record()` method is implemented now; Phase 11
 * adds the read/query side on top of the same table.
 *
 * `record()` accepts an optional transaction client (`tx`) so callers can
 * pass their active `prisma.$transaction` handle and get atomicity with
 * the business mutation, per architecture §10. Never logs credentials.
 *
 * Phase 11 adds `queryEvents()` (the read side) but deliberately does NOT
 * add any update/delete method, anywhere, ever — audit rows are
 * append-only (architecture §10, and the brief's own rule: "never delete
 * audit records"). True append-only enforcement would mean granting the
 * application's DB role INSERT/SELECT only on `audit_events`, with a
 * separate, more privileged role for any future archival/retention job —
 * architecture §10 explicitly calls that out as "out of scope for the
 * prototype." This service's surface (no write path but `record()`, no
 * delete at all) is the part of that guarantee a single DB role can't
 * already provide; the DB-role split itself is the same deferred item
 * architecture §10 named from the start, not a new gap Phase 11 is
 * introducing.
 */
@Injectable()
export class AuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantPrisma: TenantPrismaService,
  ) {}

  async record(event: AuditEventInput, tx?: PrismaTransactionLike): Promise<void> {
    const client = tx ?? this.prisma;
    await client.auditEvent.create({
      data: {
        organizationId: event.organizationId ?? null,
        actorId: event.actorId ?? null,
        action: event.action,
        resourceType: event.resourceType,
        resourceId: event.resourceId ?? null,
        previousState: (event.previousState ?? undefined) as JsonInput,
        newState: (event.newState ?? undefined) as JsonInput,
        metadata: (event.metadata ?? undefined) as JsonInput,
        ipAddress: event.ipAddress ?? null,
        userAgent: event.userAgent ?? null,
      },
    });
  }

  /**
   * Cursor-paginated, filtered read of this organization's audit trail
   * (architecture §5's `GET /audit-events`, and §5's own pagination
   * convention: `?cursor=&limit=`). Tenant-scoped the same way every other
   * read in this codebase is — through `TenantPrismaService.forOrg()`,
   * never by trusting an organizationId the caller supplied.
   */
  async queryEvents(organizationId: string, filters: QueryAuditEventsDto): Promise<QueryAuditEventsResult> {
    const scoped = this.tenantPrisma.forOrg(organizationId);
    const take = filters.limit ?? 50;
    const where = this.buildWhere(filters);

    const rows = await scoped.auditEvent.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1, // fetch one extra to know whether there's a next page
      ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;

    return {
      events: page,
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  /**
   * Same filters as `queryEvents()`, but unpaginated up to
   * `AUDIT_EXPORT_MAX_ROWS` — the raw rows for `AuditController`'s CSV
   * export to serialize. Throws if the filtered set is larger than that
   * cap, rather than silently truncating (see `AUDIT_EXPORT_MAX_ROWS`'s
   * own doc comment).
   */
  async queryEventsForExport(organizationId: string, filters: QueryAuditEventsDto) {
    const scoped = this.tenantPrisma.forOrg(organizationId);
    const where = this.buildWhere(filters);

    const rows = await scoped.auditEvent.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: AUDIT_EXPORT_MAX_ROWS + 1,
    });

    if (rows.length > AUDIT_EXPORT_MAX_ROWS) {
      throw new PayloadTooLargeException(
        `This export would contain more than ${AUDIT_EXPORT_MAX_ROWS} rows. Narrow the date range or filters and try again.`,
      );
    }
    return rows;
  }

  /**
   * Phase 13: the one sanctioned cross-tenant read of the audit trail, for
   * platform operators (AdminController, behind PlatformOperatorGuard +
   * platform.audit.read). Uses the raw client on purpose; the optional
   * `organizationId` filter exists only on this path.
   */
  async queryEventsPlatform(
    filters: QueryAuditEventsDto & { organizationId?: string },
  ): Promise<QueryAuditEventsResult> {
    const take = filters.limit ?? 50;
    const where = this.buildWhere(filters);
    if (filters.organizationId) where.organizationId = filters.organizationId;

    const rows = await this.prisma.auditEvent.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    return { events: page, nextCursor: hasMore ? page[page.length - 1].id : null };
  }

  private buildWhere(filters: QueryAuditEventsDto): Record<string, unknown> {
    const where: Record<string, unknown> = {};
    if (filters.actorId) where.actorId = filters.actorId;
    if (filters.action) where.action = filters.action;
    if (filters.resourceType) where.resourceType = filters.resourceType;
    if (filters.resourceId) where.resourceId = filters.resourceId;
    if (filters.dateFrom || filters.dateTo) {
      const createdAt: Record<string, Date> = {};
      if (filters.dateFrom) createdAt.gte = new Date(filters.dateFrom);
      if (filters.dateTo) createdAt.lte = new Date(filters.dateTo);
      where.createdAt = createdAt;
    }
    return where;
  }
}
