import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TARGET_ZOOM,
  DEFAULT_ZOOM_GATE_THRESHOLD,
  ZOOM_ANIMATION_DURATION_BASE_SECONDS,
  ZOOM_ANIMATION_DURATION_MAX_SECONDS,
  computeClampedTargetZoom,
  computeZoomAnimationDuration,
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
