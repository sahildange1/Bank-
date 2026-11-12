/**
 * Privilege-escalation rule for user/role administration: nobody may grant,
 * remove or disable anything that carries a permission they don't hold
 * themselves. Without this, anyone holding the narrow `users.manage`
 * permission could assign themselves (or a friend) the Organization Admin
 * role and inherit every permission, or strip an admin they could never
 * have created. Platform-wide and per-tenant: it only compares permission
 * keys, so it keeps working if custom roles are added later.
 */
export function permissionsMissing(actorPermissions: readonly string[], needed: Iterable<string>): string[] {
  const held = new Set(actorPermissions);
  return [...new Set(needed)].filter((p) => !held.has(p)).sort();
}
