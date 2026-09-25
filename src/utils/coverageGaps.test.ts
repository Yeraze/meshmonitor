import { describe, it, expect } from 'vitest';
import { detectCoverageGaps, estimateIntervalSec } from './coverageGaps.js';
import type { GapFixInput } from '../types/coverageAnalysis.js';

/** Two points ~roughly `deltaLat` degrees apart (~111km/deg) so tests can dial in a specific separation in metres. */
function fix(packetKey: string, firstReceivedAt: number, latitude: number, longitude = 0): GapFixInput {
  return { packetKey, firstReceivedAt, latitude, longitude };
}

describe('estimateIntervalSec', () => {
  it('uses the configured interval when provided, regardless of deltas', () => {
    const result = estimateIntervalSec([10, 10, 10, 10, 10], 'meshtastic', 45);
    expect(result).toEqual({ intervalSec: 45, source: 'configured' });
  });

  it('ignores a non-positive or non-finite configured interval', () => {
    expect(estimateIntervalSec([30, 30, 30, 30, 30], 'meshtastic', 0).source).toBe('observed');
    expect(estimateIntervalSec([30, 30, 30, 30, 30], 'meshtastic', -5).source).toBe('observed');
    expect(estimateIntervalSec([30, 30, 30, 30, 30], 'meshtastic', NaN).source).toBe('observed');
    expect(estimateIntervalSec([30, 30, 30, 30, 30], 'meshtastic', null).source).toBe('observed');
  });

  it('falls back to the protocol default with fewer than COVERAGE_INTERVAL_MIN_SAMPLES deltas', () => {
    expect(estimateIntervalSec([30, 30, 30, 30], 'meshtastic')).toEqual({ intervalSec: 30, source: 'default' });
    expect(estimateIntervalSec([], 'meshcore')).toEqual({ intervalSec: 60, source: 'default' });
  });

  it('uses the protocol default (meshtastic 30s / meshcore 60s)', () => {
    expect(estimateIntervalSec([], 'meshtastic').intervalSec).toBe(30);
    expect(estimateIntervalSec([], 'meshcore').intervalSec).toBe(60);
  });

  it('estimates the observed interval as the 25th percentile of deltas', () => {
    // Sorted: 30x8, 300 -> p25 at idx 0.25*8=2 -> 30
    const result = estimateIntervalSec([30, 30, 30, 30, 30, 30, 30, 30, 300], 'meshtastic');
    expect(result.source).toBe('observed');
    expect(result.intervalSec).toBe(30);
  });

  it('is not fooled by a run of long gaps: P25 stays near the fast baseline', () => {
    // Mostly 30s spacings, with several very long outliers mixed in.
    const deltas = [30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 900, 1200, 1500, 1800];
    const result = estimateIntervalSec(deltas, 'meshtastic');
    expect(result.source).toBe('observed');
    expect(result.intervalSec).toBe(30);
  });

  it('ignores sub-1-second deltas when estimating', () => {
    const deltas = [0.1, 0.2, 0.3, 30, 30, 30, 30, 30];
    const result = estimateIntervalSec(deltas, 'meshtastic');
    // usable = [30,30,30,30,30] (5 samples) -> observed, p25 = 30
    expect(result).toEqual({ intervalSec: 30, source: 'observed' });
  });

  it('clamps the observed interval to COVERAGE_INTERVAL_CLAMP_SEC', () => {
    const tooFast = estimateIntervalSec([1, 1, 1, 1, 1], 'meshtastic');
    expect(tooFast.intervalSec).toBe(15);
    const tooSlow = estimateIntervalSec([2000, 2000, 2000, 2000, 2000], 'meshtastic');
    expect(tooSlow.intervalSec).toBe(900);
  });
});

describe('detectCoverageGaps', () => {
  const T0 = 1_700_000_000_000;

  it('finds one gap in a steady 30s cadence with a single 150s hole (missed=4)', () => {
    // 10 fixes; index 5 sits 150s after index 4 instead of 30s. Each fix ~500m apart in latitude.
    const fixes: GapFixInput[] = [];
    let t = T0;
    for (let i = 0; i < 10; i++) {
      fixes.push(fix(`p${i}`, t, i * 0.01)); // ~1.1km per step in latitude
      t += i === 4 ? 150_000 : 30_000;
    }
    const result = detectCoverageGaps(fixes, { protocol: 'meshtastic' });
    expect(result.heard).toBe(10);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0].missedEstimate).toBe(4);
    expect(result.expected).toBe(10 + 4);
    expect(result.breaks).toBe(0);
  });

  it('does not flag a stationary pause (0m movement) as a gap', () => {
    const fixes: GapFixInput[] = [
      fix('a', T0, 10, 10),
      fix('b', T0 + 30_000, 10, 10),
      fix('c', T0 + 60_000, 10, 10),
      fix('d', T0 + 60_000 + 150_000, 10, 10), // big time jump, zero distance
      fix('e', T0 + 60_000 + 150_000 + 30_000, 10, 10),
    ];
    const result = detectCoverageGaps(fixes, { protocol: 'meshtastic' });
    expect(result.gaps).toHaveLength(0);
    expect(result.breaks).toBe(0);
  });

  it('counts a >30-minute pause as a break, not a gap', () => {
    const fixes: GapFixInput[] = [
      fix('a', T0, 0),
      fix('b', T0 + 30_000, 0.01),
      fix('c', T0 + 60_000, 0.02),
      fix('d', T0 + 60_000 + 45 * 60_000, 0.1), // 45 minutes later, far away
      fix('e', T0 + 60_000 + 45 * 60_000 + 30_000, 0.11),
    ];
    const result = detectCoverageGaps(fixes, { protocol: 'meshtastic' });
    expect(result.breaks).toBe(1);
    expect(result.gaps).toHaveLength(0);
  });

  it('falls back to the protocol default interval with fewer than 5 deltas', () => {
    const fixes: GapFixInput[] = [fix('a', T0, 0), fix('b', T0 + 30_000, 0.01), fix('c', T0 + 60_000, 0.02)];
    const result = detectCoverageGaps(fixes, { protocol: 'meshtastic' });
    expect(result.intervalSource).toBe('default');
    expect(result.intervalSec).toBe(30);
  });

  it('uses the MeshCore default (60s) when falling back', () => {
    const fixes: GapFixInput[] = [fix('a', T0, 0), fix('b', T0 + 60_000, 0.01)];
    const result = detectCoverageGaps(fixes, { protocol: 'meshcore' });
    expect(result.intervalSource).toBe('default');
    expect(result.intervalSec).toBe(60);
  });

  it('honors a configured interval over the observed one', () => {
    const fixes: GapFixInput[] = [];
    let t = T0;
    for (let i = 0; i < 8; i++) {
      fixes.push(fix(`p${i}`, t, i * 0.01));
      t += 30_000;
    }
    const result = detectCoverageGaps(fixes, { protocol: 'meshtastic', configuredIntervalSec: 10 });
    expect(result.intervalSource).toBe('configured');
    expect(result.intervalSec).toBe(10);
  });

  it('sorts unsorted input by firstReceivedAt before analysis', () => {
    const fixes: GapFixInput[] = [
      fix('c', T0 + 60_000, 0.02),
      fix('a', T0, 0),
      fix('b', T0 + 30_000, 0.01),
    ];
    const result = detectCoverageGaps(fixes, { protocol: 'meshtastic' });
    expect(result.heard).toBe(3);
    expect(result.gaps).toHaveLength(0);
  });

  it('drops exact duplicate packetKeys defensively', () => {
    const fixes: GapFixInput[] = [
      fix('a', T0, 0),
      fix('a', T0, 0), // exact duplicate
      fix('b', T0 + 30_000, 0.01),
    ];
    const result = detectCoverageGaps(fixes, { protocol: 'meshtastic' });
    expect(result.heard).toBe(2);
  });

  it('a single fix has no gaps and expected=1', () => {
    const result = detectCoverageGaps([fix('a', T0, 0)], { protocol: 'meshtastic' });
    expect(result.heard).toBe(1);
    expect(result.expected).toBe(1);
    expect(result.gaps).toHaveLength(0);
    expect(result.breaks).toBe(0);
  });

  it('empty input yields all zeros', () => {
    const result = detectCoverageGaps([], { protocol: 'meshtastic' });
    expect(result).toEqual({
      intervalSec: 30,
      intervalSource: 'default',
      gaps: [],
      breaks: 0,
      heard: 0,
      expected: 0,
    });
  });

  it('gap durationSec/distanceM/from/to are populated on the recorded gap', () => {
    const fixes: GapFixInput[] = [];
    let t = T0;
    for (let i = 0; i < 6; i++) {
      fixes.push(fix(`p${i}`, t, i * 0.02)); // ~2.2km apart, well over the 200m floor
      t += i === 2 ? 200_000 : 30_000;
    }
    const result = detectCoverageGaps(fixes, { protocol: 'meshtastic' });
    expect(result.gaps).toHaveLength(1);
    const gap = result.gaps[0];
    expect(gap.durationSec).toBe(200);
    expect(gap.distanceM).toBeGreaterThan(200);
    expect(gap.from.packetKey).toBe('p2');
    expect(gap.to.packetKey).toBe('p3');
  });
});
