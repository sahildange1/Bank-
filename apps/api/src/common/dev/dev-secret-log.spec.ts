import { logDevSecret } from './dev-secret-log';

describe('logDevSecret', () => {
  let spy: jest.SpyInstance;
  beforeEach(() => (spy = jest.spyOn(console, 'log').mockImplementation(() => undefined)));
  afterEach(() => spy.mockRestore());
  const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;

  it('is silent by default', () => {
    logDevSecret('token', env({}));
    expect(spy).not.toHaveBeenCalled();
  });
  it('prints only with the explicit opt-in outside production', () => {
    logDevSecret('token', env({ DEV_LOG_INVITE_TOKENS: 'true' }));
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it('never prints in production, even if opted in', () => {
    logDevSecret('token', env({ NODE_ENV: 'production', DEV_LOG_INVITE_TOKENS: 'true' }));
    expect(spy).not.toHaveBeenCalled();
  });
});
