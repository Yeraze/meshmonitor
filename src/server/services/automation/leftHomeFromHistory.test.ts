import { describe, it, expect } from 'vitest';
import { estimateHomeFromPositions } from './leftHomeFromHistory.js';

describe('estimateHomeFromPositions', () => {
  it('returns null for an empty list', () => {
    expect(estimateHomeFromPositions([], 150)).toBeNull();
  });

  it('returns the single point when only one fix exists', () => {
    const est = estimateHomeFromPositions([{ latitude: 46.1, longitude: 14.2 }], 150);
    expect(est).toEqual({
      latitude: 46.1,
      longitude: 14.2,
      sampleCount: 1,
      inlierCount: 1,
    });
  });

  it('drops spider-line outliers beyond the refine radius and averages the cluster', () => {
    // Tight cluster around 46.05 / 14.50, plus a kilometre-scale glitch north.
    const cluster = [
      { latitude: 46.0500, longitude: 14.5000 },
      { latitude: 46.0501, longitude: 14.5001 },
      { latitude: 46.0499, longitude: 14.4999 },
      { latitude: 46.0502, longitude: 14.5000 },
      { latitude: 46.0500, longitude: 14.5002 },
    ];
    const glitch = { latitude: 46.06, longitude: 14.50 }; // ~1.1 km north
    const est = estimateHomeFromPositions([...cluster, glitch], 150);
    expect(est).toBeTruthy();
    expect(est!.sampleCount).toBe(6);
    expect(est!.inlierCount).toBe(5);
    expect(est!.latitude).toBeGreaterThan(46.049);
    expect(est!.latitude).toBeLessThan(46.051);
    // Must not be pulled toward the glitch (~46.06).
    expect(est!.latitude).toBeLessThan(46.052);
  });
});
