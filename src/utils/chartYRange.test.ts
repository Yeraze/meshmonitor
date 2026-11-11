import { describe, it, expect } from 'vitest';
import {
  chartYDomain,
  hasFixedYBound,
  normalizeChartYRange,
  normalizeChartYRangeMap,
  parseChartYRangeMap,
  buildYRangeInput,
  withChartYRange,
} from './chartYRange';

describe('chartYRange (#6348)', () => {
  describe('chartYDomain', () => {
    it('is auto on both ends with no range', () => {
      expect(chartYDomain(null)).toEqual(['auto', 'auto']);
      expect(chartYDomain(undefined)).toEqual(['auto', 'auto']);
      expect(chartYDomain({})).toEqual(['auto', 'auto']);
    });

    it('fixes only the bounds that are set', () => {
      expect(chartYDomain({ min: 3, max: 4.2 })).toEqual([3, 4.2]);
      expect(chartYDomain({ min: 3 })).toEqual([3, 'auto']);
      expect(chartYDomain({ max: 4.2 })).toEqual(['auto', 4.2]);
    });

    it('keeps a zero bound', () => {
      expect(chartYDomain({ min: 0 })).toEqual([0, 'auto']);
    });

    it('maps stored bounds into the displayed unit', () => {
      const cToF = (c: number) => c * 9 / 5 + 32;
      expect(chartYDomain({ min: 0, max: 100 }, cToF)).toEqual([32, 212]);
      expect(chartYDomain({ max: 2 }, (v) => v * 1000)).toEqual(['auto', 2000]);
    });
  });

  describe('normalizeChartYRange', () => {
    it('drops non-finite bounds', () => {
      expect(normalizeChartYRange({ min: NaN, max: 5 })).toEqual({ max: 5 });
      expect(normalizeChartYRange({ min: Infinity })).toBeNull();
      expect(normalizeChartYRange({ min: '3', max: 4 })).toEqual({ max: 4 });
    });

    it('rejects min >= max when both are set', () => {
      expect(normalizeChartYRange({ min: 5, max: 5 })).toBeNull();
      expect(normalizeChartYRange({ min: 6, max: 5 })).toBeNull();
      expect(normalizeChartYRange({ min: -1, max: 0 })).toEqual({ min: -1, max: 0 });
    });

    it('reads non-objects and empty ranges as auto', () => {
      expect(normalizeChartYRange(null)).toBeNull();
      expect(normalizeChartYRange([1, 2])).toBeNull();
      expect(normalizeChartYRange({})).toBeNull();
    });

    it('strips unknown fields', () => {
      expect(normalizeChartYRange({ min: 1, extra: 'x' })).toEqual({ min: 1 });
    });
  });

  describe('map persistence', () => {
    it('round-trips through the stored JSON', () => {
      const map = withChartYRange({}, '!a-voltage', { min: 3, max: 4.2 });
      expect(parseChartYRangeMap(JSON.stringify(map))).toEqual({ '!a-voltage': { min: 3, max: 4.2 } });
    });

    it('removes a widget key when its range goes back to auto', () => {
      const map = { '!a-voltage': { min: 3 }, '!b-voltage': { max: 5 } };
      expect(withChartYRange(map, '!a-voltage', null)).toEqual({ '!b-voltage': { max: 5 } });
      expect(withChartYRange(map, '!a-voltage', { min: 9, max: 1 })).toEqual({ '!b-voltage': { max: 5 } });
      // The input map is not mutated.
      expect(map['!a-voltage']).toEqual({ min: 3 });
    });

    it('reads bad JSON or a non-object as no ranges', () => {
      expect(parseChartYRangeMap(undefined)).toEqual({});
      expect(parseChartYRangeMap('')).toEqual({});
      expect(parseChartYRangeMap('not json')).toEqual({});
      expect(parseChartYRangeMap('[1]')).toEqual({});
    });

    it('drops bad entries but keeps good ones', () => {
      expect(normalizeChartYRangeMap({ a: { min: 1 }, b: { min: 2, max: 1 }, c: 'x' })).toEqual({ a: { min: 1 } });
    });
  });

  describe('buildYRangeInput', () => {
    it('treats blank as auto', () => {
      expect(buildYRangeInput(null, undefined)).toEqual({ ok: true, range: null });
      expect(buildYRangeInput(3, null)).toEqual({ ok: true, range: { min: 3 } });
      expect(buildYRangeInput(null, 4.2)).toEqual({ ok: true, range: { max: 4.2 } });
    });

    it('ignores non-finite input', () => {
      expect(buildYRangeInput(NaN, 4)).toEqual({ ok: true, range: { max: 4 } });
      expect(buildYRangeInput(Infinity, Number.NEGATIVE_INFINITY)).toEqual({ ok: true, range: null });
    });

    it('requires min < max when both are set', () => {
      expect(buildYRangeInput(4, 3)).toEqual({ ok: false, error: 'order' });
      expect(buildYRangeInput(3, 3)).toEqual({ ok: false, error: 'order' });
      expect(buildYRangeInput(-5, 0)).toEqual({ ok: true, range: { min: -5, max: 0 } });
    });
  });

  it('hasFixedYBound', () => {
    expect(hasFixedYBound(null)).toBe(false);
    expect(hasFixedYBound({})).toBe(false);
    expect(hasFixedYBound({ min: 0 })).toBe(true);
  });
});
