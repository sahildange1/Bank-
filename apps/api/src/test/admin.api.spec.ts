import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AdminController } from '../modules/admin/admin.controller';
import { AdminService } from '../modules/admin/admin.service';
import { AuditService } from '../modules/audit/services/audit.service';
import { cookieFor, createApiApp, FakeUsers } from './api-harness';

const ALL_PLATFORM = [
  'platform.organizations.read',
  'platform.organizations.manage',
  'platform.audit.read',
  'platform.stats.read',
];

describe('Admin API over HTTP (real guards/pipes/filter, mocked data layer)', () => {
  let app: INestApplication;
  const adminService = {
    listOrganizations: jest.fn().mockResolvedValue({ organizations: [], nextCursor: null }),
    getOrganization: jest.fn().mockResolvedValue({ id: 'c1' }),
    changeStatus: jest.fn().mockResolvedValue({ id: 'c1', status: 'ACTIVE' }),
    getStats: jest.fn().mockResolvedValue({ organizations: {}, users: {}, payments: {} }),
  };
  const auditService = {
    queryEventsPlatform: jest.fn().mockResolvedValue({ events: [], nextCursor: null }),
    record: jest.fn().mockResolvedValue(undefined),
  };

  const users: FakeUsers = {
    operator: { id: 'op-1', organizationId: 'plat', permissions: ALL_PLATFORM, orgIsPlatform: true, hasVerifiedMfa: true },
    operatorNoMfa: { id: 'op-2', organizationId: 'plat', permissions: ALL_PLATFORM, orgIsPlatform: true, hasVerifiedMfa: false },
    operatorReadOnly: {
      id: 'op-3',
      organizationId: 'plat',
      permissions: ['platform.organizations.read'],
      orgIsPlatform: true,
      hasVerifiedMfa: true,
    },
    // A customer admin who somehow holds platform permissions: must still be locked out.
    customerWithPlatformPerms: { id: 'cu-1', organizationId: 'cust-1', permissions: ALL_PLATFORM, hasVerifiedMfa: true },
    suspendedOrgUser: { id: 'cu-2', organizationId: 'cust-2', permissions: ['payments.read'], orgStatus: 'SUSPENDED' },
  };

  beforeAll(async () => {
    app = await createApiApp({
      controllers: [AdminController],
      providers: [
        { provide: AdminService, useValue: adminService },
        { provide: AuditService, useValue: auditService },
      ],
      users,
    });
  });
  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it('401 without a session cookie, with the standard error envelope', async () => {
    const res = await request(app.getHttpServer()).get('/admin/organizations');
    expect(res.status).toBe(401);
    expect(res.body.error).toEqual(expect.objectContaining({ code: 'UNAUTHORIZED', requestId: expect.any(String) }));
    expect(adminService.listOrganizations).not.toHaveBeenCalled();
  });

  it('401 for a forged/unknown session id', async () => {
    const res = await request(app.getHttpServer()).get('/admin/organizations').set('Cookie', cookieFor('forged'));
    expect(res.status).toBe(401);
  });

  it('401 when the user’s organization is suspended, even with a live session', async () => {
    const res = await request(app.getHttpServer()).get('/admin/organizations').set('Cookie', cookieFor('suspendedOrgUser'));
    expect(res.status).toBe(401);
  });

  it('403 for a customer-organization user even if they hold platform.* permissions', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/organizations')
      .set('Cookie', cookieFor('customerWithPlatformPerms'));
    expect(res.status).toBe(403);
    expect(adminService.listOrganizations).not.toHaveBeenCalled();
  });

  it('403 for a platform operator who has not enrolled MFA', async () => {
    const res = await request(app.getHttpServer()).get('/admin/stats').set('Cookie', cookieFor('operatorNoMfa'));
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/Multi-factor/);
  });

  it('403 when the operator lacks the specific permission, 200 where granted', async () => {
    const denied = await request(app.getHttpServer()).get('/admin/stats').set('Cookie', cookieFor('operatorReadOnly'));
    expect(denied.status).toBe(403);
    const allowed = await request(app.getHttpServer())
      .get('/admin/organizations')
      .set('Cookie', cookieFor('operatorReadOnly'));
    expect(allowed.status).toBe(200);
    const manage = await request(app.getHttpServer())
      .post('/admin/organizations/c1/approve')
      .set('Cookie', cookieFor('operatorReadOnly'))
      .send({});
    expect(manage.status).toBe(403);
    expect(adminService.changeStatus).not.toHaveBeenCalled();
  });

  it('approve takes the operator identity from the session, never from the body', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/organizations/c1/approve')
      .set('Cookie', cookieFor('operator'))
      .send({});
    expect(res.status).toBe(200);
    expect(adminService.changeStatus).toHaveBeenCalledWith('op-1', 'plat', 'c1', 'approve', undefined);

    const spoof = await request(app.getHttpServer())
      .post('/admin/organizations/c1/approve')
      .set('Cookie', cookieFor('operator'))
      .send({ operatorUserId: 'someone-else' });
    expect(spoof.status).toBe(400); // unknown field rejected by forbidNonWhitelisted
  });

  it('suspend and close require a written reason (400 otherwise)', async () => {
    for (const action of ['suspend', 'close']) {
      const missing = await request(app.getHttpServer())
        .post(`/admin/organizations/c1/${action}`)
        .set('Cookie', cookieFor('operator'))
        .send({});
      expect(missing.status).toBe(400);
      const blank = await request(app.getHttpServer())
        .post(`/admin/organizations/c1/${action}`)
        .set('Cookie', cookieFor('operator'))
        .send({ reason: '' });
      expect(blank.status).toBe(400);
    }
    expect(adminService.changeStatus).not.toHaveBeenCalled();
    const ok = await request(app.getHttpServer())
      .post('/admin/organizations/c1/suspend')
      .set('Cookie', cookieFor('operator'))
      .send({ reason: 'sanctions screening hit' });
    expect(ok.status).toBe(200);
  });

  it('rejects an invalid status filter and an oversized page limit (400)', async () => {
    const bad = await request(app.getHttpServer())
      .get('/admin/organizations?status=HACKED')
      .set('Cookie', cookieFor('operator'));
    expect(bad.status).toBe(400);
    const big = await request(app.getHttpServer())
      .get('/admin/organizations?limit=100000')
      .set('Cookie', cookieFor('operator'));
    expect(big.status).toBe(400);
  });

  it('cross-organization audit search works for operators and is itself audited', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/audit-events?organizationId=c1&action=payment.created')
      .set('Cookie', cookieFor('operator'));
    expect(res.status).toBe(200);
    expect(auditService.queryEventsPlatform).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'c1', action: 'payment.created' }),
    );
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'platform.audit.viewed', actorId: 'op-1', organizationId: 'plat' }),
    );
  });
});
