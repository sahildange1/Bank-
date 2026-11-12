/**
 * Startup configuration check. Secrets used to fail only lazily, at first
 * use (e.g. the first login), so a misconfigured deployment looked healthy
 * until a user hit it. main.ts now refuses to start on any problem below,
 * and prints the problems — never the values.
 */
export interface EnvProblem {
  variable: string;
  problem: string;
}

const PLACEHOLDER = /replace-with|changeme|change-me|example|your-secret/i;

export function validateEnvironment(env: NodeJS.ProcessEnv): EnvProblem[] {
  const problems: EnvProblem[] = [];
  const production = env.NODE_ENV === 'production';
  const need = (variable: string, ok: boolean, problem: string) => {
    if (!ok) problems.push({ variable, problem });
  };

  need('DATABASE_URL', !!env.DATABASE_URL, 'is required');

  for (const variable of ['JWT_ACCESS_SECRET', 'MFA_ENCRYPTION_KEY']) {
    const value = env[variable];
    need(variable, !!value && value.length >= 32, 'is required and must be at least 32 characters');
    if (production && value) need(variable, !PLACEHOLDER.test(value), 'looks like a placeholder value');
  }
  if (production && env.JWT_ACCESS_SECRET && env.JWT_ACCESS_SECRET === env.MFA_ENCRYPTION_KEY) {
    need('MFA_ENCRYPTION_KEY', false, 'must differ from JWT_ACCESS_SECRET (one key, one purpose)');
  }

  const origins = (env.CORS_ORIGIN ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  if (production) need('CORS_ORIGIN', origins.length > 0, 'is required in production');
  for (const origin of origins) {
    need(
      'CORS_ORIGIN',
      /^https?:\/\/[^/*\s]+$/.test(origin),
      `entry "${origin}" must be a bare http(s) origin with no wildcard, path or trailing slash`,
    );
    if (production) need('CORS_ORIGIN', origin.startsWith('https://'), `entry "${origin}" must use https in production`);
  }

  if (production) {
    need('DEV_LOG_INVITE_TOKENS', env.DEV_LOG_INVITE_TOKENS !== 'true', 'must not be enabled in production');
    need('ENABLE_API_DOCS', env.ENABLE_API_DOCS !== 'true', 'public API docs are disabled in production');
  }

  const hops = env.TRUST_PROXY;
  if (hops !== undefined && hops !== '') {
    need('TRUST_PROXY', /^\d+$/.test(hops), 'must be a number of proxy hops (e.g. 1), not true/a list');
  }
  return problems;
}

export function assertValidEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  const problems = validateEnvironment(env);
  if (problems.length > 0) {
    throw new Error(
      'Invalid configuration:\n' + problems.map((p) => `  - ${p.variable}: ${p.problem}`).join('\n'),
    );
  }
}
