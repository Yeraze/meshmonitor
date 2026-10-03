import { describe, it, expect } from 'vitest';
import { findMarkersNearPoint, PROXIMITY_TOLERANCE_PX } from './mapProximity';

const c = (item: string, x: number, y: number, radius?: number) => ({ item, x, y, radius });

describe('findMarkersNearPoint (#5543)', () => {
  it('defaults to a 10 px reach', () => {
    expect(PROXIMITY_TOLERANCE_PX).toBe(10);
  });

  it('returns nothing when no marker is near', () => {
    expect(findMarkersNearPoint({ x: 0, y: 0 }, [c('a', 50, 50), c('b', 11, 0)])).toEqual([]);
  });

  it('returns a lone nearby marker', () => {
    expect(findMarkersNearPoint({ x: 0, y: 0 }, [c('a', 3, 4), c('b', 100, 0)])).toEqual([
      { item: 'a', distance: 5 },
    ]);
  });

  it('returns every stacked marker, nearest first', () => {
    const hits = findMarkersNearPoint({ x: 100, y: 100 }, [c('far', 108, 100), c('on', 100, 100), c('mid', 103, 104)]);
    expect(hits.map((h) => h.item)).toEqual(['on', 'mid', 'far']);
  });

  it('includes a marker exactly on the tolerance edge', () => {
    expect(findMarkersNearPoint({ x: 0, y: 0 }, [c('edge', 6, 8)]).map((h) => h.item)).toEqual(['edge']);
  });

  it('counts a click anywhere inside a marker wider than the tolerance', () => {
    expect(findMarkersNearPoint({ x: 0, y: 0 }, [c('big', 14, 0, 15), c('small', 14, 0, 6)]).map((h) => h.item)).toEqual([
      'big',
    ]);
  });

  it('honours a custom tolerance', () => {
    expect(findMarkersNearPoint({ x: 0, y: 0 }, [c('a', 20, 0)], 25).map((h) => h.item)).toEqual(['a']);
  });

  it('keeps input order for markers at the same distance', () => {
    const hits = findMarkersNearPoint({ x: 0, y: 0 }, [c('first', 5, 0), c('second', 0, 5), c('third', -5, 0)]);
    expect(hits.map((h) => h.item)).toEqual(['first', 'second', 'third']);
  });

  it('skips markers that failed to project', () => {
    expect(findMarkersNearPoint({ x: 0, y: 0 }, [c('nan', NaN, 0), c('ok', 1, 1)]).map((h) => h.item)).toEqual(['ok']);
  });
});
