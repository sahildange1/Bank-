import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'requiredPermissions';

/**
 * Declares which permission(s) a handler requires. Enforced server-side by
 * PermissionsGuard — never trust a frontend's hidden/disabled button state
 * as the authorization mechanism (architecture §6).
 */
export const RequirePermissions = (...permissions: string[]) => SetMetadata(PERMISSIONS_KEY, permissions);
