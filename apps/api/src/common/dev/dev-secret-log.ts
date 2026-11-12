/**
 * Invite and password-reset tokens are bearer credentials: whoever holds one
 * can set a user's password. Until real email delivery is wired to a queue
 * (the Phase 12 outbox has no worker yet), developers need some way to
 * obtain them locally. This prints one ONLY when explicitly opted in with
 * DEV_LOG_INVITE_TOKENS=true, and never in production (the process refuses
 * to start in production with the flag set — see env.validation.ts). The
 * default everywhere is silence.
 */
export function logDevSecret(message: string, env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV === 'production' || env.DEV_LOG_INVITE_TOKENS !== 'true') return;
  // eslint-disable-next-line no-console
  console.log(`[dev-only] ${message}`);
}
