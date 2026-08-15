/**
 * Position-history downsampling (#4743).
 *
 * This bounds what the map draws, so the properties that matter are: the cap is
 * actually respected, the trail keeps its true endpoints (the legend reads
 * them), and order is preserved so the line does not zig-zag backwards.
 */
import { describe, it, expect } from 'vitest';
import { downsamplePositionHistory, MAX_RENDERED_POSITION_POINTS } from './positionHistoryDownsample';

const seq = (n: number) => Array.from({ length: n }, (_, i) => i);

describe('downsamplePositionHistory', () => {
  it('returns the input untouched when already within the cap', () => {
    expect(downsamplePositionHistory(seq(10), 500)).toEqual(seq(10));
    expect(downsamplePositionHistory(seq(500), 500)).toEqual(seq(500));
  });

  it('never exceeds the cap, across a wide range of input sizes', () => {
    for (const n of [501, 1000, 5000, 15_000, 100_000]) {
      expect(downsamplePositionHistory(seq(n), 500).length).toBeLessThanOrEqual(500);
    }
  });

  it('keeps the true first and last entries', () => {
    // The legend reads oldest/newest off this array. Dropping an endpoint would
    // misreport the trail's time span while the line still looked correct.
    const out = downsamplePositionHistory(seq(15_000), 500);
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBe(14_999);
  });

  it('preserves order', () => {
    const out = downsamplePositionHistory(seq(9999), 400);
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeGreaterThan(out[i - 1]);
  });

  it('never emits a duplicate index', () => {
    // Rounding can land twice on the same index near the end, which would draw
    // a zero-length segment and an empty popup.
    for (const [n, cap] of [[501, 500], [502, 500], [999, 998], [1001, 1000]]) {
      const out = downsamplePositionHistory(seq(n), cap);
      expect(new Set(out).size).toBe(out.length);
    }
  });

  it('samples roughly evenly rather than clustering', () => {
    // A naive "take the first N" would keep the trail's start and silently drop
    // everything recent — the opposite of useful.
    const out = downsamplePositionHistory(seq(10_000), 100);
    const mid = out[Math.floor(out.length / 2)];
    expect(mid).toBeGreaterThan(4_000);
    expect(mid).toBeLessThan(6_000);
  });

  it('handles degenerate inputs without throwing', () => {
    expect(downsamplePositionHistory([], 500)).toEqual([]);
    expect(downsamplePositionHistory([1], 500)).toEqual([1]);
    expect(downsamplePositionHistory([1, 2], 1)).toEqual([1, 2]);
    expect(downsamplePositionHistory([], 0)).toEqual([]);
  });

  it('exposes a render budget that is bounded and smooth', () => {
    expect(MAX_RENDERED_POSITION_POINTS).toBeGreaterThanOrEqual(200);
    expect(MAX_RENDERED_POSITION_POINTS).toBeLessThanOrEqual(1000);
  });
});
