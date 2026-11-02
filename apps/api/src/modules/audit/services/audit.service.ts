import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { Prisma, PrismaClient } from '@prisma/client';

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
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(event: AuditEventInput, tx?: Prisma.TransactionClient | PrismaClient): Promise<void> {
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
}
