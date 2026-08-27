import { describe, it, expect } from 'vitest';
import {
  AGE_FILTER_STOP_HOURS,
  ageFilterStops,
  nearestAgeStopIndex,
  formatAgeStop,
} from './mapAgeSteps';

describe('ageFilterStops', () => {
  it('returns canonical stops below the cap plus the cap itself as the top stop', () => {
    // cap 720 (30d) exposes the full ladder; the cap coincides with a canonical stop.
    expect(ageFilterStops(720)).toEqual([1, 3, 6, 12, 24, 72, 168, 336, 720]);
  });

  it('bounds the ladder by the setting cap (default 24h shows only short stops)', () => {
    expect(ageFilterStops(24)).toEqual([1, 3, 6, 12, 24]);
    expect(ageFilterStops(168)).toEqual([1, 3, 6, 12, 24, 72, 168]);
  });

  it('appends a non-canonical cap as the final stop', () => {
    // 200 isn't a canonical stop; it becomes the top ("All") stop above 168.
    expect(ageFilterStops(200)).toEqual([1, 3, 6, 12, 24, 72, 168, 200]);
    // 10 drops the 12h stop and caps at 10.
    expect(ageFilterStops(10)).toEqual([1, 3, 6, 10]);
  });

  it('rounds and floors a finite cap to at least a single stop', () => {
    expect(ageFilterStops(1)).toEqual([1]);
    expect(ageFilterStops(2.6)).toEqual([1, 3]); // rounds to 3
  });

  it('offers every canonical stop plus an unlimited "All" top for a never/0 cap (#4947)', () => {
    expect(ageFilterStops(0)).toEqual([1, 3, 6, 12, 24, 72, 168, 336, 720, Infinity]);
    expect(ageFilterStops(Infinity)).toEqual([1, 3, 6, 12, 24, 72, 168, 336, 720, Infinity]);
  });
});

describe('nearestAgeStopIndex', () => {
  const stops = ageFilterStops(720); // [1,3,6,12,24,72,168,336,720]

  it('snaps an exact stop to its own index', () => {
    expect(nearestAgeStopIndex(stops, 24)).toBe(4);
    expect(nearestAgeStopIndex(stops, 720)).toBe(8);
  });

  it('snaps an arbitrary stored value to the nearest stop', () => {
    expect(nearestAgeStopIndex(stops, 30)).toBe(4); // 30 nearer 24 than 72
    expect(nearestAgeStopIndex(stops, 60)).toBe(5); // 60 nearer 72 than 24
    expect(nearestAgeStopIndex(stops, 500)).toBe(7); // 500 nearer 336 than 720
  });

  it('resolves an exact halfway tie to the longer stop', () => {
    // 9 is exactly halfway between 6 (idx 2) and 12 (idx 3) → 12h wins.
    expect(nearestAgeStopIndex(stops, 9)).toBe(3);
    // 48 is exactly halfway between 24 (idx 4) and 72 (idx 5) → 72h wins.
    expect(nearestAgeStopIndex(stops, 48)).toBe(5);
  });

  it('clamps below the first and above the last stop', () => {
    expect(nearestAgeStopIndex(stops, 0)).toBe(0);
    expect(nearestAgeStopIndex(stops, 9999)).toBe(8);
  });
});

describe('formatAgeStop', () => {
  it('renders the top stop as the All label', () => {
    expect(formatAgeStop(720, 720)).toBe('All');
    expect(formatAgeStop(24, 24, 'Alle')).toBe('Alle');
  });

  it('renders sub-day stops in hours', () => {
    expect(formatAgeStop(1, 720)).toBe('1h');
    expect(formatAgeStop(12, 720)).toBe('12h');
  });

  it('renders multi-day stops in days', () => {
    expect(formatAgeStop(24, 720)).toBe('1d');
    expect(formatAgeStop(72, 720)).toBe('3d');
    expect(formatAgeStop(168, 720)).toBe('7d');
    expect(formatAgeStop(336, 720)).toBe('14d');
  });

  it('appends trailing hours for non-whole-day stops', () => {
    expect(formatAgeStop(30, 720)).toBe('1d 6h');
  });

  it('labels the unlimited (Infinity) stop as All, and keeps finite stops labelled under a never/0 cap (#4947)', () => {
    expect(formatAgeStop(Infinity, 0)).toBe('All');
    expect(formatAgeStop(Infinity, Infinity, 'Alle')).toBe('Alle');
    // With a "never" (0) cap, finite stops must NOT all collapse to "All".
    expect(formatAgeStop(24, 0)).toBe('1d');
    expect(formatAgeStop(6, 0)).toBe('6h');
  });
});

describe('AGE_FILTER_STOP_HOURS', () => {
  it('is strictly ascending and tops out at 30 days', () => {
    for (let i = 1; i < AGE_FILTER_STOP_HOURS.length; i++) {
      expect(AGE_FILTER_STOP_HOURS[i]).toBeGreaterThan(AGE_FILTER_STOP_HOURS[i - 1]);
    }
    expect(AGE_FILTER_STOP_HOURS[AGE_FILTER_STOP_HOURS.length - 1]).toBe(720);
  });
});
