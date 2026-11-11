import * as fs from 'fs';
import * as path from 'path';

/**
 * Regression test for a bug the HTTP tests surfaced: main.ts used
 * `import cookieParser from 'cookie-parser'`. tsconfig has no
 * esModuleInterop, so that compiles to `cookie_parser_1.default(...)`, which
 * is undefined for this CommonJS module — the API threw on startup.
 * Nothing exercised main.ts, so it went unnoticed for several phases.
 */
describe('main.ts bootstrap imports', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.ts'), 'utf8');

  it('imports cookie-parser as a namespace (callable under this tsconfig)', () => {
    expect(source).toMatch(/import \* as cookieParser from 'cookie-parser'/);
    expect(source).not.toMatch(/import cookieParser from/);
  });

  it('every default import in main.ts really has a default export at runtime', () => {
    const defaults = [...source.matchAll(/^import (\w+) from '([^']+)'/gm)].filter(
      // @nestjs/* and local modules are authored with named exports/defaults we control.
      ([, , mod]) => !mod.startsWith('.') && mod === 'helmet',
    );
    for (const [, , mod] of defaults) {
      expect(typeof require(mod).default).toBe('function');
    }
  });

  it('cookie-parser is a callable CommonJS function', () => {
    expect(typeof require('cookie-parser')).toBe('function');
  });
});
