import { describe, it, expect } from 'vitest';
import { normalizeOwnerEmail } from './observerOwnerClaims.js';

describe('normalizeOwnerEmail (#6454)', () => {
  it('trims and lowercases a valid address', () => {
    expect(normalizeOwnerEmail('  Me@Example.COM ')).toBe('me@example.com');
    expect(normalizeOwnerEmail('a.b+tag@mail.sub.example.org')).toBe('a.b+tag@mail.sub.example.org');
  });

  it('treats empty as absent and rejects malformed addresses', () => {
    expect(normalizeOwnerEmail('')).toBeUndefined();
    expect(normalizeOwnerEmail(undefined)).toBeUndefined();
    for (const bad of ['me', 'me@example', 'me@@example.com', 'me @example.com', 'me@example..com', 'me@.example.com', 'me@example.com.']) {
      expect(normalizeOwnerEmail(bad)).toBeNull();
    }
  });

  it('rejects over-long input', () => {
    expect(normalizeOwnerEmail(`${'a'.repeat(250)}@example.com`)).toBeNull();
  });

  it('stays fast on input built to backtrack (CodeQL #270)', () => {
    const hostile = `!@!.${'!.'.repeat(120)}`; // under the length cap, so the regex itself runs
    const start = performance.now();
    expect(normalizeOwnerEmail(hostile)).toBeNull();
    expect(performance.now() - start).toBeLessThan(50);
  });
});
