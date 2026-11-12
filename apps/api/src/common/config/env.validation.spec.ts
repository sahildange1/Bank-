import { assertValidEnvironment, validateEnvironment } from './env.validation';

const GOOD = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  MFA_ENCRYPTION_KEY: 'b'.repeat(40),
  CORS_ORIGIN: 'http://localhost:3000',
} as NodeJS.ProcessEnv;
const vars = (env: NodeJS.ProcessEnv) => validateEnvironment(env).map((p) => p.variable);

describe('validateEnvironment', () => {
  it('accepts a valid development configuration', () => {
    expect(validateEnvironment(GOOD)).toEqual([]);
  });

  it('requires DATABASE_URL and strong secrets', () => {
    expect(vars({} as NodeJS.ProcessEnv)).toEqual(expect.arrayContaining(['DATABASE_URL', 'JWT_ACCESS_SECRET', 'MFA_ENCRYPTION_KEY']));
    expect(vars({ ...GOOD, JWT_ACCESS_SECRET: 'short' })).toContain('JWT_ACCESS_SECRET');
  });

  it('rejects wildcard / path CORS origins', () => {
    expect(vars({ ...GOOD, CORS_ORIGIN: '*' })).toContain('CORS_ORIGIN');
    expect(vars({ ...GOOD, CORS_ORIGIN: 'http://a.com/path' })).toContain('CORS_ORIGIN');
  });

  it('in production requires https CORS, forbids dev flags and docs', () => {
    const prod = { ...GOOD, NODE_ENV: 'production', CORS_ORIGIN: 'https://app.example.com' } as NodeJS.ProcessEnv;
    expect(validateEnvironment(prod)).toEqual([]);
    expect(vars({ ...prod, CORS_ORIGIN: 'http://app.example.com' })).toContain('CORS_ORIGIN');
    expect(vars({ ...prod, DEV_LOG_INVITE_TOKENS: 'true' })).toContain('DEV_LOG_INVITE_TOKENS');
    expect(vars({ ...prod, ENABLE_API_DOCS: 'true' })).toContain('ENABLE_API_DOCS');
    expect(vars({ ...prod, MFA_ENCRYPTION_KEY: prod.JWT_ACCESS_SECRET })).toContain('MFA_ENCRYPTION_KEY');
  });

  it('TRUST_PROXY must be numeric', () => {
    expect(vars({ ...GOOD, TRUST_PROXY: 'true' })).toContain('TRUST_PROXY');
    expect(validateEnvironment({ ...GOOD, TRUST_PROXY: '1' })).toEqual([]);
  });

  it('assertValidEnvironment lists variables but never their values', () => {
    const secret = 'sup3r-secret-but-short';
    try {
      assertValidEnvironment({ ...GOOD, JWT_ACCESS_SECRET: secret });
      fail('should throw');
    } catch (e) {
      expect((e as Error).message).toContain('JWT_ACCESS_SECRET');
      expect((e as Error).message).not.toContain(secret);
    }
  });
});
