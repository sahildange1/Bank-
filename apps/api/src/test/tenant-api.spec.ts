import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { ApprovalsController } from '../modules/approvals/approvals.controller';
import { ApprovalsService } from '../modules/approvals/approvals.service';
import { AuditController } from '../modules/audit/audit.controller';
import { AuditService } from '../modules/audit/services/audit.service';
import { PaymentsController } from '../modules/payments/payments.controller';
import { PaymentsService } from '../modules/payments/payments.service';
import { NotificationsController } from '../modules/notifications/notifications.controller';
import { NotificationsService } from '../modules/notifications/services/notifications.service';
import { cookieFor, createApiApp, FakeUsers } from './api-harness';

describe('Customer-facing API over HTTP: access control & input validation', () => {
  let app: INestApplication;
  const approvals = {
    approvePayment: jest.fn().mockResolvedValue({ finalized: true }),
    rejectPayment: jest.fn().mockResolvedValue({}),
    listApprovals: jest.fn().mockResolvedValue([]),
  };
  const audit = {
    queryEvents: jest.fn().mockResolvedValue({ events: [], nextCursor: null }),
    queryEventsForExport: jest.fn().mockResolvedValue([]),
  };
  const notifications = {
    list: jest.fn().mockResolvedValue({ notifications: [], nextCursor: null }),
    unreadCount: jest.fn().mockResolvedValue({ count: 0 }),
    markRead: jest.fn().mockResolvedValue({ read: true }),
    markAllRead: jest.fn().mockResolvedValue({ updated: 0 }),
  };

  const payments = {
    getPayment: jest.fn().mockResolvedValue({ id: 'p1', amountMinorUnits: 9_007_199_254_740_993n, currency: 'USD' }),
  };

  const users: FakeUsers = {
    approver: { id: 'u-approver', organizationId: 'org-A', permissions: ['payments.approve', 'payments.read'] },
    maker: { id: 'u-maker', organizationId: 'org-A', permissions: ['payments.create', 'payments.read'] },
    auditor: { id: 'u-auditor', organizationId: 'org-A', permissions: ['audit.read'] },
    viewer: { id: 'u-viewer', organizationId: 'org-A', permissions: ['payments.read'] },
  };

  beforeAll(async () => {
    app = await createApiApp({
      controllers: [ApprovalsController, AuditController, NotificationsController, PaymentsController],
      providers: [
        { provide: ApprovalsService, useValue: approvals },
        { provide: AuditService, useValue: audit },
        { provide: NotificationsService, useValue: notifications },
        { provide: PaymentsService, useValue: payments },
      ],
      users,
    });
  });
  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  describe('payment approvals', () => {
    it('401 unauthenticated; 403 for a maker without payments.approve (no service call)', async () => {
      const anon = await request(app.getHttpServer()).post('/payments/p1/approve').send({});
      expect(anon.status).toBe(401);
      const maker = await request(app.getHttpServer())
        .post('/payments/p1/approve')
        .set('Cookie', cookieFor('maker'))
        .send({});
      expect(maker.status).toBe(403);
      expect(approvals.approvePayment).not.toHaveBeenCalled();
    });

    it('reject needs payments.approve too, and a reason is mandatory', async () => {
      const viewer = await request(app.getHttpServer())
        .post('/payments/p1/reject')
        .set('Cookie', cookieFor('viewer'))
        .send({ reason: 'x' });
      expect(viewer.status).toBe(403);
      const noReason = await request(app.getHttpServer())
        .post('/payments/p1/reject')
        .set('Cookie', cookieFor('approver'))
        .send({});
      expect(noReason.status).toBe(400);
    });

    it('the decision is attributed to the SESSION user and org; a body cannot override either', async () => {
      const ok = await request(app.getHttpServer())
        .post('/payments/p1/approve')
        .set('Cookie', cookieFor('approver'))
        .send({ reason: 'looks fine' });
      expect(ok.status).toBe(201); // Nest's default for POST; this route sets no @HttpCode
      expect(approvals.approvePayment).toHaveBeenCalledWith('org-A', 'u-approver', 'p1', 'looks fine');

      const spoofUser = await request(app.getHttpServer())
        .post('/payments/p1/approve')
        .set('Cookie', cookieFor('approver'))
        .send({ approverUserId: 'u-other' });
      expect(spoofUser.status).toBe(400);
      const spoofOrg = await request(app.getHttpServer())
        .post('/payments/p1/approve')
        .set('Cookie', cookieFor('approver'))
        .send({ organizationId: 'org-B' });
      expect(spoofOrg.status).toBe(400);
    });
  });

  describe('money serialization', () => {
    it('returns BigInt minor units as exact decimal strings instead of failing with a 500', async () => {
      const res = await request(app.getHttpServer()).get('/payments/p1').set('Cookie', cookieFor('viewer'));
      expect(res.status).toBe(200);
      expect(res.body.amountMinorUnits).toBe('9007199254740993');
    });
  });

  describe('audit trail (tenant side)', () => {
    it('403 without audit.read; 200 with it, scoped to the session org', async () => {
      const denied = await request(app.getHttpServer()).get('/audit-events').set('Cookie', cookieFor('viewer'));
      expect(denied.status).toBe(403);
      const ok = await request(app.getHttpServer()).get('/audit-events?action=payment.created').set('Cookie', cookieFor('auditor'));
      expect(ok.status).toBe(200);
      expect(audit.queryEvents).toHaveBeenCalledWith('org-A', expect.objectContaining({ action: 'payment.created' }));
    });

    it('an organizationId filter is rejected outright (cannot be used to read another tenant)', async () => {
      for (const path of ['/audit-events?organizationId=org-B', '/audit-events/export?organizationId=org-B']) {
        const res = await request(app.getHttpServer()).get(path).set('Cookie', cookieFor('auditor'));
        expect(res.status).toBe(400);
      }
      expect(audit.queryEvents).not.toHaveBeenCalled();
      expect(audit.queryEventsForExport).not.toHaveBeenCalled();
    });

    it('validates filters: bad date, oversized limit, unknown param', async () => {
      for (const q of ['dateFrom=yesterday', 'limit=5000', 'limit=0', 'sort=asc']) {
        const res = await request(app.getHttpServer()).get(`/audit-events?${q}`).set('Cookie', cookieFor('auditor'));
        expect(res.status).toBe(400);
      }
    });

    it('CSV export returns text/csv as an attachment', async () => {
      const res = await request(app.getHttpServer()).get('/audit-events/export').set('Cookie', cookieFor('auditor'));
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/csv/);
      expect(res.headers['content-disposition']).toMatch(/attachment/);
    });
  });

  describe('notifications (own inbox only)', () => {
    it('401 anonymous; every call is keyed on the session user, with no userId parameter anywhere', async () => {
      const anon = await request(app.getHttpServer()).get('/notifications');
      expect(anon.status).toBe(401);

      await request(app.getHttpServer()).get('/notifications?unreadOnly=true&limit=5').set('Cookie', cookieFor('viewer'));
      expect(notifications.list).toHaveBeenCalledWith(
        'org-A',
        'u-viewer',
        expect.objectContaining({ unreadOnly: true, limit: 5 }),
      );

      await request(app.getHttpServer()).post('/notifications/n1/read').set('Cookie', cookieFor('viewer'));
      expect(notifications.markRead).toHaveBeenCalledWith('org-A', 'u-viewer', 'n1');

      const spoof = await request(app.getHttpServer()).get('/notifications?userId=u-maker').set('Cookie', cookieFor('viewer'));
      expect(spoof.status).toBe(400);
    });
  });
});
