/**
 * End-to-end journey over real HTTP against the REAL application and a REAL
 * Postgres: signup -> platform-operator approval -> maker/checker payment
 * flow -> audit/notifications -> suspension. Includes the negative cases
 * from the testing strategy (architecture §16): cross-organization access,
 * maker approving own payment, duplicate submission, invalid transition.
 *
 * Needs (CI provides these, see .github/workflows/ci.yml):
 *   DATABASE_URL, JWT_ACCESS_SECRET, MFA_ENCRYPTION_KEY, migrations applied,
 *   and `prisma db seed` run (permissions + platform organization).
 *   pnpm --filter @cbp/api test:e2e
 *
 * Only the ThrottlerGuard is overridden (a ~100-request journey from one IP
 * would trip it); every other guard, pipe, filter and interceptor is real.
 */
import { INestApplication } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import { configureApp } from '../src/app.setup';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { PasswordService } from '../src/modules/auth/services/password.service';
import { BENEFICIARY_COOLING_OFF_MS } from '../src/modules/beneficiaries/beneficiaries.service';

const RUN = Date.now().toString(36);
const PASSWORD = 'e2e-correct-horse-battery';
const email = (who: string) => `${who}.${RUN}@e2e.test`;

describe('maker-checker journey (e2e, real database)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: any;
  const passwords = new PasswordService();

  const ids: Record<string, string> = {};
  const as: Record<string, ReturnType<typeof request.agent>> = {};

  async function login(who: string, mail = email(who)) {
    const agent = request.agent(server);
    const res = await agent.post('/auth/login').send({ email: mail, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.mfaRequired).toBe(false);
    as[who] = agent;
    return agent;
  }

  async function addUser(organizationId: string, who: string, roleName: string) {
    const role = await prisma.role.findUniqueOrThrow({ where: { organizationId_name: { organizationId, name: roleName } } });
    const user = await prisma.user.create({
      data: { organizationId, email: email(who), passwordHash: await passwords.hash(PASSWORD), status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
    ids[who] = user.id;
    return user;
  }

  async function signUpAndApprove(label: string) {
    const signup = await request(server)
      .post('/organizations')
      .send({ legalName: `E2E ${label} ${RUN}`, adminEmail: email(`admin-${label}`), adminPassword: PASSWORD });
    expect(signup.status).toBe(201);
    const organizationId: string = signup.body.organizationId;
    ids[`org${label}`] = organizationId;

    // Gated behind approval: cannot sign in while PENDING.
    const blocked = await request(server).post('/auth/login').send({ email: email(`admin-${label}`), password: PASSWORD });
    expect(blocked.status).toBe(401);

    const approve = await as.operator.post(`/admin/organizations/${organizationId}/approve`).send({});
    expect(approve.status).toBe(200);
    expect(approve.body).toEqual({ id: organizationId, status: 'ACTIVE' });
    await login(`admin-${label}`);
    return organizationId;
  }

  it('hardening: security headers, request id echo, no-store, and cross-origin writes refused', async () => {
    const res = await request(server).get('/nonexistent-probe').set('x-request-id', 'e2e-request-1234');
    expect(res.headers['x-request-id']).toBe('e2e-request-1234');
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-powered-by']).toBeUndefined();

    const evil = await request(server).post('/auth/login').set('Origin', 'https://evil.example').send({ email: 'a@b.co', password: 'x' });
    expect(evil.status).toBe(403);
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    // Same hardening as production (helmet, request id, Origin check, no-store, pipes).
    process.env.CORS_ORIGIN ??= 'http://localhost:3000';
    configureApp(app);
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    server = app.getHttpServer();
    prisma = app.get(PrismaService);

    // Platform operator (bootstrapped the way prisma/create-platform-operator.ts does it).
    const platform = await prisma.organization.findFirst({ where: { isPlatform: true } });
    if (!platform) throw new Error('No platform organization: run `prisma db seed` before the e2e suite.');
    const opRole = await prisma.role.findUniqueOrThrow({
      where: { organizationId_name: { organizationId: platform.id, name: 'Platform Operator' } },
    });
    const operator = await prisma.user.create({
      data: { organizationId: platform.id, email: email('operator'), passwordHash: await passwords.hash(PASSWORD), status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { userId: operator.id, roleId: opRole.id } });
    ids.operator = operator.id;
    await login('operator');

    // Before MFA is enrolled the admin API refuses even a correct operator.
    const noMfa = await as.operator.get('/admin/stats');
    expect(noMfa.status).toBe(403);
    // Stand-in for completing /auth/mfa/enroll/*: the guard only requires a verified factor to exist.
    await prisma.mfaFactor.create({ data: { userId: operator.id, type: 'TOTP', secretEncrypted: 'e2e-placeholder', verified: true } });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it('signup is gated by platform approval; approved admins can then sign in', async () => {
    const orgA = await signUpAndApprove('A');
    const stats = await as.operator.get('/admin/stats');
    expect(stats.status).toBe(200);
    expect(stats.body.organizations.ACTIVE).toBeGreaterThanOrEqual(1);

    const me = await as['admin-A'].get('/organizations/me');
    expect(me.status).toBe(200);
    expect(me.body.id ?? me.body.organizationId).toBe(orgA);
  }, 60_000);

  it('runs the full maker-checker payment flow, with the negative cases', async () => {
    const orgA = ids.orgA;
    await addUser(orgA, 'maker', 'Payment Maker');
    await addUser(orgA, 'finance', 'Finance Manager');
    await addUser(orgA, 'approver', 'Payment Approver');
    await login('maker');
    await login('finance');
    await login('approver');

    // Account (created through the API), then funded directly: there is no funding endpoint.
    const acct = await as['admin-A'].post('/accounts').send({ currency: 'USD' });
    expect(acct.status).toBe(201);
    ids.account = acct.body.id;
    await prisma.account.update({ where: { id: ids.account }, data: { balanceMinorUnits: 1_000_000n } });

    const listed = await as['admin-A'].get('/accounts');
    expect(listed.status).toBe(200); // would be a 500 without BigInt serialization
    expect(typeof listed.body[0].balanceMinorUnits).toBe('string');

    // Beneficiary: maker creates, cannot verify own, finance verifies.
    const ben = await as.maker.post('/beneficiaries').send({ name: 'Supplier Ltd', accountNumber: 'GB00E2E000123' });
    expect(ben.status).toBe(201);
    ids.beneficiary = ben.body.id;
    expect((await as.maker.post(`/beneficiaries/${ids.beneficiary}/verify`).send({})).status).toBe(403);
    expect((await as.finance.post(`/beneficiaries/${ids.beneficiary}/verify`).send({})).status).toBeLessThan(300);
    // Skip the 1-hour cooling-off period by backdating the verification.
    await prisma.beneficiary.update({
      where: { id: ids.beneficiary },
      data: { verifiedAt: new Date(Date.now() - BENEFICIARY_COOLING_OFF_MS - 60_000) },
    });

    // Payment: create (idempotent), submit.
    const body = {
      sourceAccountId: ids.account,
      beneficiaryId: ids.beneficiary,
      amountMinorUnits: '5000',
      currency: 'USD',
      reference: 'INV-1',
      idempotencyKey: `e2e-${RUN}-1`,
    };
    const created = await as.maker.post('/payments').send(body);
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('DRAFT');
    expect(created.body.amountMinorUnits).toBe('5000');
    ids.payment = created.body.id;

    // Duplicate submission: same idempotency key returns the SAME payment, no second row.
    const dup = await as.maker.post('/payments').send(body);
    expect(dup.body.id).toBe(ids.payment);
    expect(await prisma.payment.count({ where: { idempotencyKey: body.idempotencyKey } })).toBe(1);

    const submitted = await as.maker.post(`/payments/${ids.payment}/submit`).send({});
    expect(submitted.status).toBeLessThan(300);
    expect(submitted.body.status).toBe('PENDING_APPROVAL');

    // Invalid transition: submitting again is a 409, not a silent no-op.
    expect((await as.maker.post(`/payments/${ids.payment}/submit`).send({})).status).toBe(409);

    // Maker-checker: the maker cannot approve their own payment (and lacks the permission anyway);
    // even an approver who is ALSO the maker is blocked — covered at DB level in approvals.integration.
    expect((await as.maker.post(`/payments/${ids.payment}/approve`).send({})).status).toBe(403);

    // Cross-organization: a different organization cannot see or act on it.
    await signUpAndApprove('B');
    expect((await as['admin-B'].get(`/payments/${ids.payment}`)).status).toBe(404);
    expect((await as['admin-B'].post(`/payments/${ids.payment}/approve`).send({})).status).toBe(404);
    const listB = await as['admin-B'].get('/payments');
    expect(listB.body.map((p: { id: string }) => p.id)).not.toContain(ids.payment);

    // Approver approves; the payment is APPROVED; a second decision is refused.
    const approved = await as.approver.post(`/payments/${ids.payment}/approve`).send({ reason: 'ok' });
    expect(approved.status).toBeLessThan(300);
    const after = await as.maker.get(`/payments/${ids.payment}`);
    expect(after.body.status).toBe('APPROVED');
    expect((await as.approver.post(`/payments/${ids.payment}/approve`).send({})).status).toBe(409);
    expect((await as.approver.post(`/payments/${ids.payment}/reject`).send({ reason: 'changed my mind' })).status).toBe(409);

    // History records every transition in order.
    const history = await as.maker.get(`/payments/${ids.payment}/history`);
    expect(history.body.map((h: { toState: string }) => h.toState)).toEqual(['PENDING_APPROVAL', 'APPROVED']);
  }, 120_000);

  it('records the journey in the audit trail, visible only to the owning organization', async () => {
    const mine = await as['admin-A'].get(`/audit-events?resourceId=${ids.payment}&limit=100`);
    expect(mine.status).toBe(200);
    const actions = mine.body.events.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['payment.created', 'payment.submitted', 'payment.approved']));

    const theirs = await as['admin-B'].get(`/audit-events?resourceId=${ids.payment}`);
    expect(theirs.body.events).toEqual([]);
    expect((await as['admin-B'].get(`/audit-events?organizationId=${ids.orgA}`)).status).toBe(400);

    // Operators can search across organizations; that read is itself audited.
    const platformView = await as.operator.get(`/admin/audit-events?organizationId=${ids.orgA}&action=payment.approved`);
    expect(platformView.status).toBe(200);
    expect(platformView.body.events.length).toBeGreaterThan(0);
    const viewed = await prisma.auditEvent.count({ where: { actorId: ids.operator, action: 'platform.audit.viewed' } });
    expect(viewed).toBeGreaterThan(0);
  }, 60_000);

  it('notifies the maker (only) once the payment is approved', async () => {
    const inbox = await as.maker.get('/notifications');
    expect(inbox.status).toBe(200);
    const approvedNote = inbox.body.notifications.find((n: { type: string }) => n.type === 'payment.approved');
    expect(approvedNote).toBeDefined();
    expect(approvedNote.resourceId).toBe(ids.payment);

    const other = await as.approver.get('/notifications');
    expect(other.body.notifications.find((n: { type: string }) => n.type === 'payment.approved')).toBeUndefined();

    // Someone else's notification id is a 404, not a 403 or a success.
    expect((await as.approver.post(`/notifications/${approvedNote.id}/read`).send({})).status).toBe(404);

    const before = await as.maker.get('/notifications/unread-count');
    expect((await as.maker.post(`/notifications/${approvedNote.id}/read`).send({})).status).toBeLessThan(300);
    const afterCount = await as.maker.get('/notifications/unread-count');
    expect(afterCount.body.count).toBe(before.body.count - 1);
  }, 60_000);

  it('suspending an organization signs its users out immediately and blocks new logins', async () => {
    const suspend = await as.operator.post(`/admin/organizations/${ids.orgA}/suspend`).send({ reason: 'e2e check' });
    expect(suspend.status).toBe(200);

    expect((await as['admin-A'].get('/organizations/me')).status).toBe(401); // live session, now dead
    expect((await as.maker.get('/payments')).status).toBe(401);
    const relogin = await request(server).post('/auth/login').send({ email: email('admin-A'), password: PASSWORD });
    expect(relogin.status).toBe(401);

    // An invalid transition from the operator side is a 409.
    expect((await as.operator.post(`/admin/organizations/${ids.orgA}/approve`).send({})).status).toBe(409);

    const reactivate = await as.operator.post(`/admin/organizations/${ids.orgA}/reactivate`).send({});
    expect(reactivate.status).toBe(200);
    expect((await request(server).post('/auth/login').send({ email: email('admin-A'), password: PASSWORD })).status).toBe(200);
  }, 60_000);
});
