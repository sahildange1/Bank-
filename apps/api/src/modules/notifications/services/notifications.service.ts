import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { TenantPrismaService } from '../../../common/prisma/tenant-prisma.service';
import { EMAIL_PROVIDER, EmailProvider } from '../providers/email-provider';
import type { QueryNotificationsDto } from '../dto/query-notifications.dto';

export interface NotifyInput {
  organizationId: string;
  userId: string;
  type: string;
  title: string;
  body: string;
  resourceType?: string;
  resourceId?: string;
  /** Also queue an email; delivered later by dispatchPendingEmails(). */
  email?: boolean;
}

export const EMAIL_DISPATCH_BATCH = 50;

/**
 * In-app notifications plus an email outbox. Recipients only ever read and
 * mark their OWN notifications: every read/update filters on both the
 * tenant (via forOrg) and the session's userId, so another user's
 * notification id is indistinguishable from a nonexistent one (no IDOR).
 *
 * Email is never sent inline (architecture §3: workers own email). notify()
 * only marks a row PENDING; dispatchPendingEmails() — what a future
 * repeatable queue job would call, deliberately not exposed over HTTP, same
 * as Phase 10's payment execution — drains them through the provider.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantPrisma: TenantPrismaService,
    @Inject(EMAIL_PROVIDER) private readonly emailProvider: EmailProvider,
  ) {}

  /**
   * Best-effort by design: a notification failure must never roll back or
   * fail the business action that triggered it, so errors are logged and
   * swallowed. Callers should invoke this AFTER their transaction commits.
   */
  async notify(input: NotifyInput): Promise<void> {
    try {
      const scoped = this.tenantPrisma.forOrg(input.organizationId);
      await scoped.notification.create({
        data: {
          organizationId: input.organizationId,
          userId: input.userId,
          type: input.type,
          title: input.title,
          body: input.body,
          resourceType: input.resourceType ?? null,
          resourceId: input.resourceId ?? null,
          emailStatus: input.email ? 'PENDING' : 'NOT_REQUESTED',
        },
      });
    } catch (err) {
      this.logger.error(`Failed to create notification (${input.type}): ${(err as Error).message}`);
    }
  }

  async list(organizationId: string, userId: string, filters: QueryNotificationsDto) {
    const scoped = this.tenantPrisma.forOrg(organizationId);
    const take = filters.limit ?? 20;
    const rows = await scoped.notification.findMany({
      where: { userId, ...(filters.unreadOnly ? { readAt: null } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    return { notifications: page, nextCursor: hasMore ? page[page.length - 1].id : null };
  }

  async unreadCount(organizationId: string, userId: string): Promise<{ count: number }> {
    const scoped = this.tenantPrisma.forOrg(organizationId);
    return { count: await scoped.notification.count({ where: { userId, readAt: null } }) };
  }

  async markRead(organizationId: string, userId: string, notificationId: string): Promise<{ read: true }> {
    const scoped = this.tenantPrisma.forOrg(organizationId);
    // Already-read rows are fine (idempotent), so match on ownership only.
    const owned = await scoped.notification.findFirst({ where: { id: notificationId, userId }, select: { id: true } });
    if (!owned) throw new NotFoundException();
    await scoped.notification.updateMany({
      where: { id: notificationId, userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { read: true };
  }

  async markAllRead(organizationId: string, userId: string): Promise<{ updated: number }> {
    const scoped = this.tenantPrisma.forOrg(organizationId);
    const result = await scoped.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: result.count };
  }

  /**
   * Worker entry point: sends up to EMAIL_DISPATCH_BATCH queued emails.
   * Cross-tenant by nature (a worker serves every org), so it uses the raw
   * client — the same sanctioned escape hatch as reconciliation. A failed
   * send marks the row FAILED instead of retrying forever; retry policy
   * belongs to the future queue layer.
   */
  async dispatchPendingEmails(): Promise<{ sent: number; failed: number }> {
    const pending = await this.prisma.notification.findMany({
      where: { emailStatus: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: EMAIL_DISPATCH_BATCH,
      include: { user: { select: { email: true } } },
    });

    let sent = 0;
    let failed = 0;
    for (const n of pending) {
      try {
        await this.emailProvider.send({ to: n.user.email, subject: n.title, body: n.body });
        await this.prisma.notification.update({
          where: { id: n.id },
          data: { emailStatus: 'SENT', emailSentAt: new Date() },
        });
        sent++;
      } catch (err) {
        this.logger.error(`Email for notification ${n.id} failed: ${(err as Error).message}`);
        await this.prisma.notification.update({ where: { id: n.id }, data: { emailStatus: 'FAILED' } });
        failed++;
      }
    }
    return { sent, failed };
  }
}
