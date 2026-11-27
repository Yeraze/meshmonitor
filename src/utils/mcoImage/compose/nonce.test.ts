import { describe, expect, it } from 'vitest';
import { pickShortestNonce } from './nonce.js';

describe('pickShortestNonce', () => {
  const build = (n: number): string => 'x'.repeat(n < 40 ? 10 : n < 90 ? 11 : 12);
  it('returns a shortest text and spreads over ties', () => {
    expect(pickShortestNonce(build, () => 0)).toEqual({ nonce: 0, text: 'x'.repeat(10) });
    expect(pickShortestNonce(build, () => 0.999).nonce).toBe(39);
    const mid = pickShortestNonce(build, () => 0.5);
    expect(mid.nonce).toBe(20);
    expect(mid.text.length).toBe(10);
  });
  it('finds the shortest when it is rare', () => {
    const r = pickShortestNonce((n) => 'y'.repeat(n === 200 ? 5 : 6), () => 0.3);
    expect(r).toEqual({ nonce: 200, text: 'y'.repeat(5) });
  });
});
