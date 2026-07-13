import { describe, it, expect } from 'vitest';
import { isNullIsland, isValidLatLng, isBogusPosition, NULL_ISLAND_EPSILON } from './nullIsland.js';

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

describe('isValidLatLng', () => {
  it('accepts in-range real-world coordinates (including exact extremes)', () => {
    expect(isValidLatLng(26.33, -80.27)).toBe(true); // South Florida
    expect(isValidLatLng(0, 0)).toBe(true); // valid range (Null Island is in-range but bogus)
    expect(isValidLatLng(90, 180)).toBe(true);
    expect(isValidLatLng(-90, -180)).toBe(true);
  });

  it('rejects out-of-range coordinates (the observed MeshCore advert junk)', () => {
    expect(isValidLatLng(1853.453892, 1819.635571)).toBe(false);
    expect(isValidLatLng(-471.156916, 595.308254)).toBe(false);
    expect(isValidLatLng(90.62051, -1598.745966)).toBe(false); // lat just over 90
    expect(isValidLatLng(540.096308, 4.408389)).toBe(false);
    expect(isValidLatLng(0, 180.0001)).toBe(false);
    expect(isValidLatLng(90.0001, 0)).toBe(false);
  });

  it('rejects missing / non-finite coordinates', () => {
    expect(isValidLatLng(null, 0)).toBe(false);
    expect(isValidLatLng(0, undefined)).toBe(false);
    expect(isValidLatLng(NaN, 0)).toBe(false);
    expect(isValidLatLng(0, Infinity)).toBe(false);
  });
});

describe('isBogusPosition', () => {
  it('rejects BOTH null-island and out-of-range coordinates (superset of isNullIsland)', () => {
    expect(isBogusPosition(0, 0)).toBe(true); // null island
    expect(isBogusPosition(0.0005, -0.0009)).toBe(true); // near null island
    expect(isBogusPosition(1853.453892, 1819.635571)).toBe(true); // out of range
    expect(isBogusPosition(90.62051, -1598.745966)).toBe(true);
    expect(isBogusPosition(NaN, 0)).toBe(true); // non-finite is bogus when present
  });

  it('accepts legitimate in-range positions', () => {
    expect(isBogusPosition(26.33, -80.27)).toBe(false);
    expect(isBogusPosition(-33.8688, 151.2093)).toBe(false);
    expect(isBogusPosition(51.4778, 0.0001)).toBe(false); // Greenwich — near-zero lng, real lat
  });

  it('treats a missing position as not-bogus (no coordinate to reject)', () => {
    expect(isBogusPosition(null, null)).toBe(false);
    expect(isBogusPosition(26.33, null)).toBe(false);
    expect(isBogusPosition(undefined, -80.27)).toBe(false);
  });
});
