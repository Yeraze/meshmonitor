import { describe, it, expect } from 'vitest';
import { nearestPoint, measureLabel, midpoint, type MeasurePoint } from './measureDistance';

const A: MeasurePoint = { id: 'a', lat: 40.0, lng: -105.0, label: 'A' };
const B: MeasurePoint = { id: 'b', lat: 40.5, lng: -105.0, label: 'B' };
const C: MeasurePoint = { id: 'c', lat: 41.0, lng: -105.0, label: 'C' };

describe('nearestPoint', () => {
  it('returns null for an empty list', () => {
    expect(nearestPoint([], 40, -105)).toBeNull();
  });

  it('returns the only point when the list has one', () => {
    expect(nearestPoint([A], 0, 0)?.id).toBe('a');
  });

  it('picks the closest point by great-circle distance', () => {
    // Click just south of A — A should win over B and C which are further north.
    expect(nearestPoint([C, B, A], 39.9, -105.0)?.id).toBe('a');
    // Click near C.
    expect(nearestPoint([A, B, C], 41.1, -105.0)?.id).toBe('c');
  });

  it('breaks ties in favor of the earlier point', () => {
    const left: MeasurePoint = { id: 'left', lat: 0, lng: -1 };
    const right: MeasurePoint = { id: 'right', lat: 0, lng: 1 };
    // Equidistant click at the origin -> first listed wins.
    expect(nearestPoint([left, right], 0, 0)?.id).toBe('left');
    expect(nearestPoint([right, left], 0, 0)?.id).toBe('right');
  });
});

describe('measureLabel', () => {
  it('formats in km by default', () => {
    // ~0.5 degrees latitude ≈ 55.6 km
    const label = measureLabel(A, B, 'km');
    expect(label).toMatch(/km$/);
    expect(parseFloat(label)).toBeCloseTo(55.6, 0);
  });

  it('formats in miles when requested', () => {
    const label = measureLabel(A, B, 'mi');
    expect(label).toMatch(/mi$/);
    expect(parseFloat(label)).toBeCloseTo(34.5, 0);
  });

  it('reports zero distance for identical points', () => {
    expect(measureLabel(A, A, 'km')).toBe('0.0 km');
  });
});

describe('midpoint', () => {
  it('averages the two coordinates', () => {
    expect(midpoint(A, C)).toEqual([40.5, -105.0]);
  });
});
