import { describe, it, expect } from 'vitest';
import { sortHeardBy } from './meshcoreHeardBy.js';

describe('sortHeardBy (#6000)', () => {
  it('sorts by hops ascending, then SNR descending', () => {
    const out = sortHeardBy([
      { hash: 'c', hops: 1, snr: 9 },
      { hash: 'a', hops: 0, snr: 2 },
      { hash: 'b', hops: 0, snr: 6 },
    ]);
    expect(out.map((e) => e.hash)).toEqual(['b', 'a', 'c']);
  });

  it('puts entries with no hop count (old rows) last, and missing SNR after present SNR', () => {
    const out = sortHeardBy([
      { hash: 'old', hops: null, snr: 10 },
      { hash: 'nosnr', hops: 0, snr: null },
      { hash: 'snr', hops: 0, snr: -3 },
      { hash: 'old2' },
    ]);
    expect(out.map((e) => e.hash)).toEqual(['snr', 'nosnr', 'old', 'old2']);
  });

  it('does not mutate its input', () => {
    const input = [{ hops: 2 }, { hops: 1 }];
    sortHeardBy(input);
    expect(input[0].hops).toBe(2);
  });
});
