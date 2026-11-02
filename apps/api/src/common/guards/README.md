# Guards

`PermissionsGuard` (enforces `@RequirePermissions(...)` decorators against the
caller's session) and `TenantScopeGuard` (rejects cross-organization access —
architecture §7) are implemented in Phase 4 alongside authentication.
