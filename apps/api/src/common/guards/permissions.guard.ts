import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { PERMISSIONS_KEY } from '../decorators/require-permissions.decorator';

/**
 * Must run after SessionAuthGuard (it reads request.authContext, which only
 * SessionAuthGuard sets). Denies by default: a handler with no
 * @RequirePermissions() and no explicit @Public() is NOT implicitly open —
 * see the empty-metadata check below.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[] | undefined>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No @RequirePermissions() declared at all is a configuration error for
    // any handler sitting behind this guard, not an "allow" — fail closed.
    if (!required) {
      throw new ForbiddenException('This endpoint has no declared permission requirement');
    }
    if (required.length === 0) {
      return true; // @RequirePermissions() with no args: explicitly "authenticated only"
    }

    const request = context.switchToHttp().getRequest<Request>();
    const granted = new Set(request.authContext?.permissions ?? []);
    const hasAll = required.every((p) => granted.has(p));
    if (!hasAll) {
      throw new ForbiddenException('Insufficient permissions');
    }
    return true;
  }
}
