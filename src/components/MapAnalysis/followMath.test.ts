import { describe, it, expect } from 'vitest';
import { averageLatLng, planAutoZoom, AUTOZOOM_PAD } from './followMath';

describe('averageLatLng', () => {
  it('returns null for an empty set', () => {
    expect(averageLatLng([])).toBeNull();
  });

  it('returns the point itself for a single point', () => {
    expect(averageLatLng([[10, 20]])).toEqual([10, 20]);
  });

  it('returns the arithmetic mean for multiple points', () => {
    expect(averageLatLng([[0, 0], [10, 20]])).toEqual([5, 10]);
  });
});

describe('planAutoZoom', () => {
  it('returns none for an empty set', () => {
    expect(planAutoZoom([])).toEqual({ kind: 'none' });
  });

  it('returns single for a single point', () => {
    expect(planAutoZoom([[10, 20]])).toEqual({ kind: 'single', center: [10, 20] });
  });

  it('returns single for coincident points', () => {
    expect(planAutoZoom([[5, 5], [5, 5]])).toEqual({ kind: 'single', center: [5, 5] });
  });

  it('returns multi with an exact 15% pad for a spread of points', () => {
    // span: lat 0..10 (10), lng 0..20 (20); pad 0.15 => 1.5 / 3 each side
    expect(planAutoZoom([[0, 0], [10, 20]])).toEqual({
      kind: 'multi',
      bounds: [[-1.5, -3], [11.5, 23]],
    });
  });

  it('respects a custom pad argument', () => {
    // span: lat 0..10 (10), lng 0..20 (20); pad 0.5 => 5 / 10 each side
    expect(planAutoZoom([[0, 0], [10, 20]], 0.5)).toEqual({
      kind: 'multi',
      bounds: [[-5, -10], [15, 30]],
    });
  });

  it('exports the default pad as 0.15', () => {
    expect(AUTOZOOM_PAD).toBe(0.15);
  });
});
