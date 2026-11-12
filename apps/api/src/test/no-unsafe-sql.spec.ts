import * as fs from 'fs';
import * as path from 'path';

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)],
  );
}

describe('SQL injection guard', () => {
  const files = walk(path.join(__dirname, '..')).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'));
  it('production code never uses $queryRawUnsafe / $executeRawUnsafe', () => {
    const offenders = files.filter((f) => /\$(query|execute)RawUnsafe/.test(fs.readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
  it('raw queries are only tagged templates (parameterised)', () => {
    const offenders = files.filter((f) => /\$(queryRaw|executeRaw)\s*\(/.test(fs.readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
