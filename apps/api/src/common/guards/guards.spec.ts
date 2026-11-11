import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../decorators/require-permissions.decorator';
import { PermissionsGuard } from './permissions.guard';
import { SessionAuthGuard } from './session-auth.guard';

function ctxWith(request: any, required?: string[]) {
  const handler = () => undefined;
  if (required) Reflect.defineMetadata(PERMISSIONS_KEY, required, handler);
  return {
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('PermissionsGuard (permission evaluation)', () => {
  const guard = new PermissionsGuard(new Reflector());
  const req = (permissions: string[]) => ({ authContext: { permissions } });

  it('fails closed when a route declares no permission requirement at all', () => {
    expect(() => guard.canActivate(ctxWith(req(['payments.read'])))).toThrow(ForbiddenException);
  });

  it('@RequirePermissions() with no args means authenticated-only', () => {
    expect(guard.canActivate(ctxWith(req([]), []))).toBe(true);
  });

  it('requires ALL listed permissions, not any', () => {
    const ctx = (p: string[]) => ctxWith(req(p), ['payments.create', 'payments.read']);
    expect(guard.canActivate(ctx(['payments.create', 'payments.read', 'accounts.read']))).toBe(true);
    expect(() => guard.canActivate(ctx(['payments.create']))).toThrow(ForbiddenException);
  });

  it('denies when there is no auth context (guard ordering mistake fails closed)', () => {
    expect(() => guard.canActivate(ctxWith({}, ['payments.read']))).toThrow(ForbiddenException);
  });

  it('permission matching is exact: no prefix or wildcard matching', () => {
    expect(() => guard.canActivate(ctxWith(req(['payments.*']), ['payments.read']))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctxWith(req(['payments']), ['payments.read']))).toThrow(ForbiddenException);
  });
});

describe('SessionAuthGuard', () => {
  function make(opts: { session?: any; user?: any }) {
    const sessions = { validateAndTouch: jest.fn().mockResolvedValue(opts.session ?? null) };
    const prisma = { user: { findUnique: jest.fn().mockResolvedValue(opts.user ?? null) } };
    const guard = new SessionAuthGuard(sessions as any, prisma as any);
    const request: any = { cookies: {} };
    return { guard, request, sessions, prisma };
  }
  const ctx = (request: any) => ({ switchToHttp: () => ({ getRequest: () => request }) }) as unknown as ExecutionContext;
  const USER = (over: any = {}) => ({
    id: 'u1',
    organizationId: 'o1',
    status: 'ACTIVE',
    organization: { status: 'ACTIVE' },
    userRoles: [{ role: { rolePermissions: [{ permission: { key: 'payments.read' } }, { permission: { key: 'payments.read' } }] } }],
    ...over,
  });

  it('401 with no cookie, and the database is never consulted', async () => {
    const { guard, request, sessions } = make({});
    await expect(guard.canActivate(ctx(request))).rejects.toThrow(UnauthorizedException);
    expect(sessions.validateAndTouch).not.toHaveBeenCalled();
  });

  it('401 for a non-string cookie value (e.g. an injected array/object)', async () => {
    const { guard, request } = make({});
    request.cookies.cbp_session = { $ne: null };
    await expect(guard.canActivate(ctx(request))).rejects.toThrow(UnauthorizedException);
  });

  it('401 when the session is unknown, revoked or expired', async () => {
    const { guard, request } = make({ session: null });
    request.cookies.cbp_session = 'abc';
    await expect(guard.canActivate(ctx(request))).rejects.toThrow(UnauthorizedException);
  });

  it.each(['INVITED', 'DISABLED', 'LOCKED'])('401 when the user status is %s', async (status) => {
    const { guard, request } = make({ session: { id: 's', userId: 'u1' }, user: USER({ status }) });
    request.cookies.cbp_session = 'abc';
    await expect(guard.canActivate(ctx(request))).rejects.toThrow(UnauthorizedException);
  });

  it.each(['PENDING', 'SUSPENDED', 'CLOSED'])('401 when the organization is %s (even with a live session)', async (status) => {
    const { guard, request } = make({ session: { id: 's', userId: 'u1' }, user: USER({ organization: { status } }) });
    request.cookies.cbp_session = 'abc';
    await expect(guard.canActivate(ctx(request))).rejects.toThrow(UnauthorizedException);
  });

  it('attaches org and de-duplicated permissions taken from the database, not the request', async () => {
    const { guard, request } = make({ session: { id: 's1', userId: 'u1' }, user: USER() });
    request.cookies.cbp_session = 'abc';
    request.headers = { 'x-organization-id': 'attacker-org' };
    await expect(guard.canActivate(ctx(request))).resolves.toBe(true);
    expect(request.authContext).toEqual({
      userId: 'u1',
      organizationId: 'o1',
      sessionId: 's1',
      permissions: ['payments.read'],
    });
  });
});
