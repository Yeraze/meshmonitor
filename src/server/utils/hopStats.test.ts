import { describe, it, expect } from 'vitest';
import { computeRollingHopStats } from './hopStats.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('computeRollingHopStats', () => {
  it('returns [] with no samples', () => {
    expect(computeRollingHopStats([], 0, 15, 10 * HOUR)).toEqual([]);
  });

  // Golden values hand-computed from the original getSmartHopsStats algorithm.
  it('matches the rolling 24h min/max/avg on interval boundaries', () => {
    const base = 100 * HOUR; // aligned to 15 min
    const samples = [
      { timestamp: base + 1 * MIN, value: 1 },
      { timestamp: base + 20 * MIN, value: 3 },
      { timestamp: base + 40 * MIN, value: 2 },
    ];
    const out = computeRollingHopStats(samples, base, 15, base + 45 * MIN);
    expect(out).toEqual([
      // base itself: no sample at or before it
      { timestamp: base + 15 * MIN, minHops: 1, maxHops: 1, avgHops: 1 },
      { timestamp: base + 30 * MIN, minHops: 1, maxHops: 3, avgHops: 2 },
      { timestamp: base + 45 * MIN, minHops: 1, maxHops: 3, avgHops: 2 },
    ]);
  });

  it('rounds avg to 2 decimals and drops samples older than 24h', () => {
    const t = 200 * HOUR;
    const samples = [
      { timestamp: t - 25 * HOUR, value: 7 }, // outside window
      { timestamp: t - 2 * HOUR, value: 1 },
      { timestamp: t - 1 * HOUR, value: 1 },
      { timestamp: t - 30 * MIN, value: 2 },
    ];
    const out = computeRollingHopStats(samples, t, 15, t);
    expect(out).toEqual([{ timestamp: t, minHops: 1, maxHops: 2, avgHops: 1.33 }]);
  });

  it('sorts unsorted input', () => {
    const t = 300 * HOUR;
    const out = computeRollingHopStats(
      [{ timestamp: t - 1000, value: 4 }, { timestamp: t - 2000, value: 2 }],
      t, 15, t
    );
    expect(out[0]).toMatchObject({ minHops: 2, maxHops: 4, avgHops: 3 });
  });
});
