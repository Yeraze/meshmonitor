import { describe, it, expect } from 'vitest';
import { markerAgeOpacity, MIN_MARKER_OPACITY } from './markerAgeOpacity';

describe('markerAgeOpacity', () => {
  const fresh = 100_000;
  const stale = 0;

  it('is fully opaque at (and beyond) the fresh boundary', () => {
    expect(markerAgeOpacity(fresh, stale, fresh)).toBe(1);
    expect(markerAgeOpacity(fresh, stale, fresh + 5_000)).toBe(1);
  });

  it('is at the floor at (and beyond) the stale boundary', () => {
    expect(markerAgeOpacity(fresh, stale, stale)).toBe(MIN_MARKER_OPACITY);
    expect(markerAgeOpacity(fresh, stale, stale - 5_000)).toBe(MIN_MARKER_OPACITY);
  });

  it('scales linearly between the boundaries', () => {
    // Halfway → halfway between floor and 1.
    const mid = markerAgeOpacity(fresh, stale, 50_000);
    expect(mid).toBeCloseTo(MIN_MARKER_OPACITY + 0.5 * (1 - MIN_MARKER_OPACITY), 6);
  });

  it('never drops below the floor and is monotonic with recency', () => {
    const newer = markerAgeOpacity(fresh, stale, 80_000);
    const older = markerAgeOpacity(fresh, stale, 20_000);
    expect(newer).toBeGreaterThan(older);
    expect(older).toBeGreaterThanOrEqual(MIN_MARKER_OPACITY);
  });

  it('honours a custom floor', () => {
    expect(markerAgeOpacity(fresh, stale, stale, 0.1)).toBe(0.1);
    expect(markerAgeOpacity(fresh, stale, 50_000, 0.1)).toBeCloseTo(0.55, 6);
  });

  it('returns 1 for a missing or non-finite timestamp (no fade)', () => {
    expect(markerAgeOpacity(fresh, stale, null)).toBe(1);
    expect(markerAgeOpacity(fresh, stale, undefined)).toBe(1);
    expect(markerAgeOpacity(fresh, stale, NaN)).toBe(1);
  });

  it('returns 1 for a degenerate window (fresh <= stale)', () => {
    expect(markerAgeOpacity(stale, fresh, 50_000)).toBe(1);
    expect(markerAgeOpacity(fresh, fresh, 50_000)).toBe(1);
  });
});
