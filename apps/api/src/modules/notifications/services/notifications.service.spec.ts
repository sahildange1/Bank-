import { NotFoundException } from '@nestjs/common';
import { NotificationsService, EMAIL_DISPATCH_BATCH } from './notifications.service';

describe('NotificationsService (unit, mocked Prisma)', () => {
  const ORG = 'org-1';
  const USER = 'user-1';

  function makeService() {
    const scoped = {
      notification: {
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        count: jest.fn(),
        updateMany: jest.fn(),
      },
    };
    const raw = { notification: { findMany: jest.fn(), update: jest.fn().mockResolvedValue({}) } };
    const tenantPrisma = { forOrg: jest.fn().mockReturnValue(scoped) };
    const email = { send: jest.fn().mockResolvedValue(undefined) };
    const service = new NotificationsService(raw as any, tenantPrisma as any, email as any);
    return { service, scoped, raw, tenantPrisma, email };
  }

  const ROW = (id: string) => ({ id, userId: USER, title: 't', body: 'b', readAt: null });

  describe('notify', () => {
    it('creates a tenant-scoped row, NOT_REQUESTED by default', async () => {
      const { service, scoped, tenantPrisma } = makeService();
      await service.notify({ organizationId: ORG, userId: USER, type: 'x', title: 't', body: 'b' });
      expect(tenantPrisma.forOrg).toHaveBeenCalledWith(ORG);
      expect(scoped.notification.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ organizationId: ORG, userId: USER, emailStatus: 'NOT_REQUESTED' }),
      });
    });

    it('queues the email as PENDING when requested', async () => {
      const { service, scoped, email } = makeService();
      await service.notify({ organizationId: ORG, userId: USER, type: 'x', title: 't', body: 'b', email: true });
      expect(scoped.notification.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ emailStatus: 'PENDING' }),
      });
      expect(email.send).not.toHaveBeenCalled(); // never inline
    });

    it('swallows failures so the triggering business action is never broken', async () => {
      const { service, scoped } = makeService();
      scoped.notification.create.mockRejectedValue(new Error('db down'));
      await expect(
        service.notify({ organizationId: ORG, userId: USER, type: 'x', title: 't', body: 'b' }),
      ).resolves.toBeUndefined();
    });
  });

  describe('list', () => {
    it("only ever queries the caller's own userId", async () => {
      const { service, scoped } = makeService();
      scoped.notification.findMany.mockResolvedValue([]);
      await service.list(ORG, USER, {});
      expect(scoped.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: USER }, take: 21 }),
      );
    });

    it('filters unread and paginates via the take-one-extra sentinel', async () => {
      const { service, scoped } = makeService();
      scoped.notification.findMany.mockResolvedValue([ROW('a'), ROW('b'), ROW('c')]);
      const res = await service.list(ORG, USER, { unreadOnly: true, limit: 2, cursor: 'z' });
      expect(scoped.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: USER, readAt: null }, cursor: { id: 'z' }, skip: 1 }),
      );
      expect(res.notifications.map((n: { id: string }) => n.id)).toEqual(['a', 'b']);
      expect(res.nextCursor).toBe('b');
    });
  });

  describe('markRead / markAllRead / unreadCount', () => {
    it('404s (not 403) for a notification that is not the caller’s, hiding its existence', async () => {
      const { service, scoped } = makeService();
      scoped.notification.findFirst.mockResolvedValue(null);
      await expect(service.markRead(ORG, USER, 'someone-elses')).rejects.toThrow(NotFoundException);
      expect(scoped.notification.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'someone-elses', userId: USER } }),
      );
      expect(scoped.notification.updateMany).not.toHaveBeenCalled();
    });

    it('marks an owned notification read, scoped by id AND userId', async () => {
      const { service, scoped } = makeService();
      scoped.notification.findFirst.mockResolvedValue({ id: 'n1' });
      scoped.notification.updateMany.mockResolvedValue({ count: 1 });
      await expect(service.markRead(ORG, USER, 'n1')).resolves.toEqual({ read: true });
      expect(scoped.notification.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'n1', userId: USER, readAt: null } }),
      );
    });

    it('markAllRead only touches the caller’s unread rows', async () => {
      const { service, scoped } = makeService();
      scoped.notification.updateMany.mockResolvedValue({ count: 3 });
      await expect(service.markAllRead(ORG, USER)).resolves.toEqual({ updated: 3 });
      expect(scoped.notification.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: USER, readAt: null } }),
      );
    });

    it('unreadCount counts only the caller’s unread rows', async () => {
      const { service, scoped } = makeService();
      scoped.notification.count.mockResolvedValue(4);
      await expect(service.unreadCount(ORG, USER)).resolves.toEqual({ count: 4 });
      expect(scoped.notification.count).toHaveBeenCalledWith({ where: { userId: USER, readAt: null } });
    });
  });

  describe('dispatchPendingEmails', () => {
    it('sends each PENDING email and marks it SENT', async () => {
      const { service, raw, email } = makeService();
      raw.notification.findMany.mockResolvedValue([
        { id: 'n1', title: 'T', body: 'B', user: { email: 'a@x.test' } },
      ]);
      await expect(service.dispatchPendingEmails()).resolves.toEqual({ sent: 1, failed: 0 });
      expect(raw.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { emailStatus: 'PENDING' }, take: EMAIL_DISPATCH_BATCH }),
      );
      expect(email.send).toHaveBeenCalledWith({ to: 'a@x.test', subject: 'T', body: 'B' });
      expect(raw.notification.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'n1' }, data: expect.objectContaining({ emailStatus: 'SENT' }) }),
      );
    });

    it('marks FAILED (no infinite retry) when the provider throws, and continues with the rest', async () => {
      const { service, raw, email } = makeService();
      raw.notification.findMany.mockResolvedValue([
        { id: 'n1', title: 'T', body: 'B', user: { email: 'a@x.test' } },
        { id: 'n2', title: 'T', body: 'B', user: { email: 'b@x.test' } },
      ]);
      email.send.mockRejectedValueOnce(new Error('smtp down'));
      await expect(service.dispatchPendingEmails()).resolves.toEqual({ sent: 1, failed: 1 });
      expect(raw.notification.update).toHaveBeenCalledWith({ where: { id: 'n1' }, data: { emailStatus: 'FAILED' } });
    });
  });
});
