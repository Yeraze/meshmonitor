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
    // This pattern + input would peg a native RegExp for many seconds; RE2 is
    // linear. A larger input makes the native case definitively slow while RE2
    // stays well under a generous threshold (kept high to avoid CI flakiness on
    // loaded/slow runners — correctness is "fast", not a precise budget).
    const re = compileUserRegex('(a+)+$');
    const start = Date.now();
    const result = re.test('a'.repeat(100) + 'X');
    const elapsed = Date.now() - start;
    expect(result).toBe(false);
    expect(elapsed).toBeLessThan(1000);
  });

  it('exposes RegExp-compatible source and flags', () => {
    // RE2 instances are not `instanceof RegExp`, but they expose the standard
    // accessors, which is what call sites rely on.
    const re = compileUserRegex('^ab.*', 'i');
    expect(re.source).toBe('^ab.*');
    expect(re.flags).toContain('i');
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
