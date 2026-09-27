import { describe, it, expect } from 'vitest';
import {
  TrackThinner,
  thinTrack,
  distanceFromChordMeters,
  TRACK_POINT_BUDGET,
  TRACK_GAP_MS,
  type TrackFix,
} from './trackThinning.js';

const T0 = 1_760_000_000_000;
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

interface Fix extends TrackFix {
  source?: string;
}

function fix(timestamp: number, latitude: number, longitude: number, source?: string): Fix {
  return { timestamp, latitude, longitude, ...(source ? { source } : {}) };
}

function flatten<T>(segments: T[][]): T[] {
  return segments.flat();
}

describe('trackThinning (#5354 Phase 2)', () => {
  it('passes a small track through untouched', () => {
    const fixes = [fix(T0, 1, 1), fix(T0 + MIN, 1.001, 1), fix(T0 + 2 * MIN, 1.002, 1)];
    const out = thinTrack(fixes, { windowEndMs: T0 + 3 * MIN });
    expect(out.totalFixes).toBe(3);
    expect(out.segments).toHaveLength(1);
    expect(out.segments[0].map((f) => f.timestamp)).toEqual([T0, T0 + MIN, T0 + 2 * MIN]);
  });

  it('returns nothing for no fixes', () => {
    expect(thinTrack([], { windowEndMs: T0 })).toEqual({ totalFixes: 0, segments: [] });
  });

  it('respects the 2,000-point budget on a dense 90-day track', () => {
    const thinner = new TrackThinner<Fix>({ windowEndMs: T0 + 90 * DAY });
    let n = 0;
    // One fix every 30 s for 90 days (~259k fixes), wandering in a circle.
    for (let ts = T0; ts < T0 + 90 * DAY; ts += 30 * SEC) {
      const a = (n++ / 500) * Math.PI;
      thinner.push(fix(ts, 40 + Math.sin(a) * 0.1, -75 + Math.cos(a) * 0.1));
    }
    const out = thinner.finish();
    expect(out.totalFixes).toBe(n);
    const points = flatten(out.segments);
    expect(points.length).toBeLessThanOrEqual(TRACK_POINT_BUDGET);
    // The budget is actually used, not squandered.
    expect(points.length).toBeGreaterThan(TRACK_POINT_BUDGET / 2);
    expect(out.segments).toHaveLength(1);
    // Endpoints of the whole track survive.
    expect(points[0].timestamp).toBe(T0);
    expect(points[points.length - 1].timestamp).toBe(T0 + 90 * DAY - 30 * SEC);
    // Time order is kept.
    for (let i = 1; i < points.length; i++) expect(points[i].timestamp).toBeGreaterThan(points[i - 1].timestamp);
  });

  it('keeps the turn of an out-and-back trip inside one bucket', () => {
    // One bucket (bucketCount 1): out east for 50 fixes, then back west.
    const fixes: Fix[] = [];
    for (let i = 0; i <= 100; i++) {
      const east = i <= 50 ? i : 100 - i;
      fixes.push(fix(T0 + i * 10 * SEC, 40, -75 + east * 0.001));
    }
    const out = thinTrack(fixes, { windowEndMs: T0 + 1001 * SEC, bucketCount: 1 });
    const points = flatten(out.segments);
    expect(points).toHaveLength(3);
    // The far point (the turn) is kept even though start and end coincide.
    expect(points[1].longitude).toBeCloseTo(-75 + 50 * 0.001, 6);
  });

  it('keeps a right-angle corner', () => {
    const fixes: Fix[] = [];
    for (let i = 0; i <= 20; i++) fixes.push(fix(T0 + i * SEC * 10, 40, -75 + i * 0.001)); // east
    for (let i = 1; i <= 20; i++) fixes.push(fix(T0 + (20 + i) * SEC * 10, 40 + i * 0.001, -75 + 0.02)); // north
    const out = thinTrack(fixes, { windowEndMs: T0 + 410 * SEC, bucketCount: 1 });
    const points = flatten(out.segments);
    expect(points.some((p) => p.latitude === 40 && Math.abs(p.longitude - (-75 + 0.02)) < 1e-9)).toBe(true);
  });

  it('splits segments at gaps over 30 minutes, not at exactly 30', () => {
    const fixes = [
      fix(T0, 1, 1),
      fix(T0 + MIN, 1.001, 1),
      fix(T0 + MIN + TRACK_GAP_MS, 1.002, 1), // exactly 30 min: same segment
      fix(T0 + MIN + TRACK_GAP_MS + TRACK_GAP_MS + 1, 1.5, 1.5), // just over: new segment
      fix(T0 + MIN + 2 * TRACK_GAP_MS + MIN, 1.501, 1.5),
    ];
    const out = thinTrack(fixes, { windowEndMs: T0 + 2 * HOUR });
    expect(out.segments.map((s) => s.length)).toEqual([3, 2]);
    expect(out.segments[1][0].latitude).toBe(1.5);
  });

  it('keeps first and last fix of every gap segment under budget pressure', () => {
    // 20 drives of 1,000 fixes each, separated by 2 h gaps, with a tiny budget.
    const fixes: Fix[] = [];
    const starts: number[] = [];
    const ends: number[] = [];
    let ts = T0;
    for (let d = 0; d < 20; d++) {
      starts.push(ts);
      for (let i = 0; i < 1000; i++) {
        fixes.push(fix(ts, 40 + d * 0.01 + Math.sin(i / 20) * 0.001, -75 + i * 0.0001));
        if (i < 999) ts += 5 * SEC;
      }
      ends.push(ts);
      ts += 2 * HOUR;
    }
    const out = thinTrack(fixes, { windowEndMs: ts, budget: 100 });
    expect(out.segments).toHaveLength(20);
    expect(flatten(out.segments).length).toBeLessThanOrEqual(100);
    out.segments.forEach((seg, i) => {
      expect(seg[0].timestamp).toBe(starts[i]);
      expect(seg[seg.length - 1].timestamp).toBe(ends[i]);
    });
  });

  it('samples endpoints evenly when every fix is its own segment', () => {
    // A fix every 31 minutes: each one is a separate segment.
    const fixes: Fix[] = [];
    for (let i = 0; i < 500; i++) fixes.push(fix(T0 + i * 31 * MIN, 40 + i * 0.001, -75));
    const out = thinTrack(fixes, { windowEndMs: T0 + 500 * 31 * MIN, budget: 50 });
    const points = flatten(out.segments);
    expect(points.length).toBeLessThanOrEqual(50);
    expect(points[0].timestamp).toBe(T0);
    expect(points[points.length - 1].timestamp).toBe(T0 + 499 * 31 * MIN);
  });

  it('dedupes the same fix heard by two sources', () => {
    const fixes = [
      fix(T0, 40.123456, -75.654321, 'a'),
      fix(T0 + 800, 40.1234561, -75.6543209, 'b'), // same fix, other source, rounds to same 5 dp
      fix(T0 + 30 * SEC, 40.124, -75.654, 'a'),
      fix(T0 + 30 * SEC + 4 * SEC, 40.124, -75.654, 'b'),
    ];
    const out = thinTrack(fixes, { windowEndMs: T0 + MIN });
    expect(out.totalFixes).toBe(2);
    expect(flatten(out.segments).map((f) => f.source)).toEqual(['a', 'a']);
  });

  it('does not dedupe a real repeat outside 5 s, or a different position', () => {
    const fixes = [
      fix(T0, 40, -75),
      fix(T0 + 6 * SEC, 40, -75), // same place, 6 s later: a genuine fix
      fix(T0 + 7 * SEC, 40.0001, -75), // 1 s later but moved
    ];
    const out = thinTrack(fixes, { windowEndMs: T0 + MIN });
    expect(out.totalFixes).toBe(3);
  });

  it('measures chord distance, including a zero-length chord', () => {
    const a = fix(0, 0, 0);
    const b = fix(0, 0, 0.01);
    expect(distanceFromChordMeters(fix(0, 0.001, 0.005), a, b)).toBeCloseTo(110.54, 0);
    expect(distanceFromChordMeters(fix(0, 0.001, 0), a, a)).toBeCloseTo(110.54, 0);
  });

  it('rejects push after finish', () => {
    const thinner = new TrackThinner<Fix>({ windowEndMs: T0 });
    thinner.finish();
    expect(() => thinner.push(fix(T0, 1, 1))).toThrow();
  });
});
