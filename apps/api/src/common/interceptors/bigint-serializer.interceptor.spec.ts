import { serializeBigInts } from './bigint-serializer.interceptor';

describe('serializeBigInts', () => {
  it('turns bigint money fields into lossless decimal strings, including past 2^53', () => {
    const huge = 9_007_199_254_740_993n; // not representable as a JS number
    expect(serializeBigInts({ balanceMinorUnits: huge })).toEqual({ balanceMinorUnits: '9007199254740993' });
  });

  it('recurses through arrays and nested objects', () => {
    expect(serializeBigInts({ items: [{ a: 1n }, { a: 2n, b: { c: 3n } }] })).toEqual({
      items: [{ a: '1' }, { a: '2', b: { c: '3' } }],
    });
  });

  it('leaves dates, null, strings, numbers and booleans untouched', () => {
    const d = new Date('2026-01-01T00:00:00Z');
    expect(serializeBigInts({ d, n: null, s: 'x', num: 5, ok: true })).toEqual({ d, n: null, s: 'x', num: 5, ok: true });
    expect(serializeBigInts(d)).toBe(d);
  });

  it('result is JSON.stringify-safe (the original bug)', () => {
    expect(() => JSON.stringify({ x: 1n })).toThrow(/BigInt/);
    expect(() => JSON.stringify(serializeBigInts({ x: 1n }))).not.toThrow();
  });
});
