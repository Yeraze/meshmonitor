import { describe, it, expect } from 'vitest';
import { compileUserRegex } from './safeRegex.js';

describe('compileUserRegex', () => {
  it('compiles and matches like RegExp (test/match)', () => {
    const re = compileUserRegex('^router', 'i');
    expect(re.test('Router-North')).toBe(true);
    expect(re.test('node-1')).toBe(false);
    expect('Router-North'.match(re)?.[0]).toBe('Router');
  });

  it('supports capture groups for param extraction', () => {
    const re = compileUserRegex('^!(\\w+) (.+)$', 'i');
    const m = 'weather Houston'.replace(/^/, '!').match(re);
    expect(m?.[1]).toBe('weather');
    expect(m?.[2]).toBe('Houston');
  });

  it('is immune to catastrophic backtracking (ReDoS)', () => {
    // This pattern + input pegs a native RegExp for seconds; RE2 is linear.
    const re = compileUserRegex('(a+)+$');
    const start = Date.now();
    const result = re.test('a'.repeat(50) + 'X');
    const elapsed = Date.now() - start;
    expect(result).toBe(false);
    expect(elapsed).toBeLessThan(100); // would be multi-second on native RegExp
  });

  it('throws on an invalid pattern (callers catch and treat as invalid)', () => {
    expect(() => compileUserRegex('(')).toThrow();
  });

  it('throws on unsupported constructs (backreference / lookaround)', () => {
    // RE2 rejects exactly the features that enable ReDoS — the intended trade-off.
    expect(() => compileUserRegex('(?<=x)y')).toThrow();
    expect(() => compileUserRegex('(a)\\1')).toThrow();
  });
});
