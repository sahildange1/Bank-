import * as fs from 'fs';
import * as path from 'path';
import 'reflect-metadata';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { SessionAuthGuard } from '../common/guards/session-auth.guard';
import { PERMISSIONS_KEY } from '../common/decorators/require-permissions.decorator';

/**
 * Deny-by-default regression test for broken access control. It inspects
 * every route of every controller (discovered from disk, so a NEW
 * controller is covered automatically) and fails if a route is reachable
 * without SessionAuthGuard unless it is on the explicit PUBLIC list, or
 * lacks PermissionsGuard + a declared permission unless it is on the
 * SESSION_ONLY list. Adding a public route must be a deliberate edit here.
 */
const PUBLIC = new Set([
  'AuthController.login',
  'AuthController.verifyMfa',
  'AuthController.resetPasswordRequest',
  'AuthController.resetPassword',
  'OrganizationsController.signUp',
  'UsersController.acceptInvite',
  // Orchestrator probes: no data returned, see health.controller.ts.
  'HealthController.live',
  'HealthController.ready',
]);

// Authenticated-only on purpose: every signed-in user may act on their OWN session/inbox.
const SESSION_ONLY = new Set([
  'AuthController.logout',
  'AuthController.me',
  'AuthController.enrollMfaStart',
  'AuthController.enrollMfaConfirm',
  'NotificationsController.list',
  'NotificationsController.unreadCount',
  'NotificationsController.markAllRead',
  'NotificationsController.markRead',
  'OrganizationsController.getMyOrganization', // @RequirePermissions() with no args: own org profile
]);

function loadControllers(): Array<{ name: string; cls: any }> {
  const root = path.join(__dirname, '..', 'modules');
  const found: Array<{ name: string; cls: any }> = [];
  for (const dir of fs.readdirSync(root)) {
    const full = path.join(root, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const file of fs.readdirSync(full)) {
      if (!file.endsWith('.controller.ts')) continue;
      const mod = require(path.join(full, file));
      for (const exported of Object.values(mod) as any[]) {
        if (typeof exported === 'function' && Reflect.getMetadata('path', exported) !== undefined) {
          found.push({ name: exported.name, cls: exported });
        }
      }
    }
  }
  return found;
}

describe('route guard coverage (deny by default)', () => {
  const controllers = loadControllers();
  const routes: Array<{ id: string; guards: any[]; permissions: unknown }> = [];

  for (const { name, cls } of controllers) {
    for (const method of Object.getOwnPropertyNames(cls.prototype)) {
      const handler = cls.prototype[method];
      if (method === 'constructor' || typeof handler !== 'function') continue;
      if (Reflect.getMetadata('method', handler) === undefined) continue; // not a route
      routes.push({
        id: `${name}.${method}`,
        guards: [...(Reflect.getMetadata('__guards__', cls) ?? []), ...(Reflect.getMetadata('__guards__', handler) ?? [])],
        permissions: Reflect.getMetadata(PERMISSIONS_KEY, handler) ?? Reflect.getMetadata(PERMISSIONS_KEY, cls),
      });
    }
  }

  it('discovers the application controllers (guards the sweep itself)', () => {
    expect(controllers.length).toBeGreaterThanOrEqual(10);
    expect(routes.length).toBeGreaterThanOrEqual(50);
  });

  it('every allowlist entry still refers to a real route (no stale exemptions)', () => {
    const ids = new Set(routes.map((r) => r.id));
    for (const id of [...PUBLIC, ...SESSION_ONLY]) expect(ids).toContain(id);
  });

  it.each(routes.filter((r) => !PUBLIC.has(r.id)).map((r) => [r.id, r] as const))(
    '%s requires an authenticated session',
    (_id, route) => {
      expect(route.guards).toContain(SessionAuthGuard);
    },
  );

  it.each(routes.filter((r) => !PUBLIC.has(r.id) && !SESSION_ONLY.has(r.id)).map((r) => [r.id, r] as const))(
    '%s declares a permission and is checked by PermissionsGuard',
    (_id, route) => {
      expect(route.guards).toContain(PermissionsGuard);
      expect(Array.isArray(route.permissions)).toBe(true);
      expect((route.permissions as string[]).length).toBeGreaterThan(0);
    },
  );

  it('public routes do not accidentally also claim guards', () => {
    for (const r of routes.filter((x) => PUBLIC.has(x.id))) expect(r.guards).toEqual([]);
  });

  it('no /admin route is reachable without the platform-operator guard', () => {
    const admin = routes.filter((r) => r.id.startsWith('AdminController.'));
    expect(admin.length).toBeGreaterThan(0);
    for (const r of admin) {
      expect(r.guards.map((g: any) => g.name)).toEqual(['SessionAuthGuard', 'PlatformOperatorGuard', 'PermissionsGuard']);
    }
  });
});
