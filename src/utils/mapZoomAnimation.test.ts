import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TARGET_ZOOM,
  DEFAULT_ZOOM_GATE_THRESHOLD,
  ZOOM_ANIMATION_DURATION_BASE_SECONDS,
  ZOOM_ANIMATION_DURATION_MAX_SECONDS,
  computeClampedTargetZoom,
  computeZoomAnimationDuration,
  hasNearbyPoint,
} from './mapZoomAnimation';

describe('mapZoomAnimation constants (#4046)', () => {
  it('exposes the documented defaults', () => {
    expect(DEFAULT_TARGET_ZOOM).toBe(17);
    expect(DEFAULT_ZOOM_GATE_THRESHOLD).toBe(13);
  });
});

describe('computeClampedTargetZoom (#4046 item 2)', () => {
  it('zooms in when the current zoom is further out than the target', () => {
    expect(computeClampedTargetZoom(10, 17)).toBe(17);
    expect(computeClampedTargetZoom(1, 17)).toBe(17);
  });

  it('never zooms out when the current zoom is already at or past the target', () => {
    expect(computeClampedTargetZoom(18, 17)).toBe(18);
    expect(computeClampedTargetZoom(17, 17)).toBe(17);
  });

  it('handles a target of 0 and negative deltas correctly (still just Math.max)', () => {
    expect(computeClampedTargetZoom(5, 0)).toBe(5);
  });
});

describe('computeZoomAnimationDuration (#4046 item 3)', () => {
  it('returns the base duration for a zero zoom delta', () => {
    expect(computeZoomAnimationDuration(15, 15)).toBeCloseTo(ZOOM_ANIMATION_DURATION_BASE_SECONDS, 5);
  });

  it('is symmetric in the sign of the delta (zooming in vs out by the same amount)', () => {
    const a = computeZoomAnimationDuration(10, 15);
    const b = computeZoomAnimationDuration(15, 10);
    expect(a).toBeCloseTo(b, 10);
  });

  it('grows monotonically with the size of the zoom delta, up to the cap', () => {
    const d1 = computeZoomAnimationDuration(15, 16); // delta 1
    const d2 = computeZoomAnimationDuration(15, 17); // delta 2
    const d5 = computeZoomAnimationDuration(15, 20); // delta 5
    expect(d2).toBeGreaterThan(d1);
    expect(d5).toBeGreaterThan(d2);
  });

  it('never exceeds the documented cap, even for a huge zoom delta', () => {
    const duration = computeZoomAnimationDuration(1, 18); // delta 17
    expect(duration).toBeLessThanOrEqual(ZOOM_ANIMATION_DURATION_MAX_SECONDS);
    expect(duration).toBe(ZOOM_ANIMATION_DURATION_MAX_SECONDS);
  });

  it('never returns less than the base duration', () => {
    const duration = computeZoomAnimationDuration(15, 15.5);
    expect(duration).toBeGreaterThanOrEqual(ZOOM_ANIMATION_DURATION_BASE_SECONDS);
  });
});

describe('hasNearbyPoint (#4551)', () => {
  const target = { x: 100, y: 100 };

  it('reports no neighbour for an isolated point — the reported case', () => {
    // A node 200km away projects far outside the 20px overlap radius at any
    // usable zoom. Nothing to disambiguate, so the click must not be gated.
    expect(hasNearbyPoint(target, [{ x: 4000, y: 3000 }], 20)).toBe(false);
  });

  it('reports a neighbour for a co-located point (a genuine pile)', () => {
    expect(hasNearbyPoint(target, [{ x: 100, y: 100 }], 20)).toBe(true);
  });

  it('treats the radius as inclusive at the boundary', () => {
    expect(hasNearbyPoint(target, [{ x: 120, y: 100 }], 20)).toBe(true);
    expect(hasNearbyPoint(target, [{ x: 120.5, y: 100 }], 20)).toBe(false);
  });

  it('measures euclidean distance, not per-axis distance', () => {
    // dx=15, dy=15 is 15px on each axis but ~21.2px apart — outside a 20px
    // radius. A naive `dx < r && dy < r` check would wrongly call this nearby.
    expect(hasNearbyPoint(target, [{ x: 115, y: 115 }], 20)).toBe(false);
    // dx=12, dy=12 is ~17px — genuinely inside.
    expect(hasNearbyPoint(target, [{ x: 112, y: 112 }], 20)).toBe(true);
  });

  it('returns false for an empty neighbour set', () => {
    expect(hasNearbyPoint(target, [], 20)).toBe(false);
  });

  it('short-circuits on the first match without scanning the rest', () => {
    let visited = 0;
    function* candidates() {
      visited++; yield { x: 100, y: 100 };
      visited++; yield { x: 101, y: 101 };
    }
    expect(hasNearbyPoint(target, candidates(), 20)).toBe(true);
    expect(visited).toBe(1);
  });

  it('treats a non-positive radius as "nothing is nearby"', () => {
    // Guards the self-match case: with r=0 a co-located point would otherwise
    // satisfy `0 <= 0` and gate every marker.
    expect(hasNearbyPoint(target, [{ x: 100, y: 100 }], 0)).toBe(false);
    expect(hasNearbyPoint(target, [{ x: 100, y: 100 }], -5)).toBe(false);
  });
});
