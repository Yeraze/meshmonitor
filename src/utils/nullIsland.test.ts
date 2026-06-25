import { describe, it, expect } from 'vitest';
import { isNullIsland, NULL_ISLAND_EPSILON } from './nullIsland.js';

describe('isNullIsland', () => {
  it('flags exactly (0, 0)', () => {
    expect(isNullIsland(0, 0)).toBe(true);
  });

  it('flags near-zero values within the epsilon (firmware rounding / float serialization)', () => {
    expect(isNullIsland(0.000001, 0)).toBe(true);
    expect(isNullIsland(0, 0.000001)).toBe(true);
    expect(isNullIsland(-0.0005, 0.0009)).toBe(true);
  });

  it('does not flag a coordinate at or beyond the epsilon on either axis', () => {
    expect(isNullIsland(NULL_ISLAND_EPSILON, 0)).toBe(false);
    expect(isNullIsland(0, NULL_ISLAND_EPSILON)).toBe(false);
    expect(isNullIsland(0.01, 0)).toBe(false);
  });

  it('does not flag legitimate real-world positions', () => {
    expect(isNullIsland(37.7749, -122.4194)).toBe(false); // San Francisco
    expect(isNullIsland(51.5074, -0.1278)).toBe(false); // London (near 0° lon, far from 0° lat)
    expect(isNullIsland(0.5, 0.5)).toBe(false);
    expect(isNullIsland(-33.8688, 151.2093)).toBe(false); // Sydney
  });

  it('treats a near-zero longitude with a real latitude as a real position', () => {
    // The Greenwich meridian crosses populated land; only BOTH axes near zero is Null Island.
    expect(isNullIsland(51.4778, 0.0001)).toBe(false); // Greenwich Observatory
  });

  it('returns false for missing or non-finite coordinates', () => {
    expect(isNullIsland(null, null)).toBe(false);
    expect(isNullIsland(0, null)).toBe(false);
    expect(isNullIsland(undefined, 0)).toBe(false);
    expect(isNullIsland(NaN, 0)).toBe(false);
    expect(isNullIsland(0, Infinity)).toBe(false);
  });
});
