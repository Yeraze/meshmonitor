import { describe, it, expect } from 'vitest';
import {
  isNullIsland,
  isValidLatLng,
  isBogusPosition,
  isNullIslandWithPrecision,
  precisionOffsetDegrees,
  NULL_ISLAND_EPSILON,
} from './nullIsland.js';

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

  it('rejects a position-precision-obscured (0,0) fix only when precisionBits is supplied', () => {
    // A node truly at (0,0) on a 14-bit-precision channel transmits (offset, offset).
    const offset14 = precisionOffsetDegrees(14); // 0.0131072°
    // Without precision context it clears the plain box (regression the fix addresses)...
    expect(isBogusPosition(offset14, offset14)).toBe(false);
    // ...but with the sender's precisionBits it is correctly rejected.
    expect(isBogusPosition(offset14, offset14, 14)).toBe(true);
  });

  it('still accepts a real position when precisionBits is supplied', () => {
    expect(isBogusPosition(26.33, -80.27, 14)).toBe(false);
    expect(isBogusPosition(-33.8688, 151.2093, 10)).toBe(false);
  });
});

describe('precisionOffsetDegrees', () => {
  it('computes 2^(31 - bits) * 1e-7 for obscured precision', () => {
    expect(precisionOffsetDegrees(16)).toBeCloseTo(0.0032768, 12); // 2^15 * 1e-7
    expect(precisionOffsetDegrees(14)).toBeCloseTo(0.0131072, 12); // 2^17 * 1e-7 — the ~0.013 reports
    expect(precisionOffsetDegrees(12)).toBeCloseTo(0.0524288, 12); // 2^19 * 1e-7
  });

  it('returns 0 for full precision, disabled precision, or unknown values', () => {
    expect(precisionOffsetDegrees(32)).toBe(0); // full precision
    expect(precisionOffsetDegrees(0)).toBe(0);  // disabled
    expect(precisionOffsetDegrees(undefined)).toBe(0);
    expect(precisionOffsetDegrees(null)).toBe(0);
    expect(precisionOffsetDegrees(NaN)).toBe(0);
  });
});

describe('isNullIslandWithPrecision', () => {
  it('rejects a true-(0,0) fix re-centered by any obscured precision level', () => {
    // For a masked origin of 0, the received coordinate is exactly the offset.
    for (const bits of [16, 15, 14, 13, 12, 11, 10]) {
      const offset = precisionOffsetDegrees(bits);
      expect(isNullIslandWithPrecision(offset, offset, bits)).toBe(true);
    }
  });

  it('handles the realistic decoded coordinate (latitudeI/1e7), not just the exact offset', () => {
    // latitudeI = longitudeI = 2^17 for a true-(0,0) node at 14-bit precision.
    const decoded = 131072 / 1e7; // how meshtasticProtobufService.convertCoordinates yields it
    expect(isNullIslandWithPrecision(decoded, decoded, 14)).toBe(true);
  });

  it('is identical to the plain box when precision is undefined / full / disabled', () => {
    expect(isNullIslandWithPrecision(0, 0, undefined)).toBe(true);
    expect(isNullIslandWithPrecision(0.0131072, 0.0131072, undefined)).toBe(false);
    expect(isNullIslandWithPrecision(0.0131072, 0.0131072, 32)).toBe(false); // full precision, no offset
    expect(isNullIslandWithPrecision(0.0131072, 0.0131072, 0)).toBe(false);  // disabled, no offset
  });

  it('never flags a real position after backing out the (small) offset', () => {
    expect(isNullIslandWithPrecision(37.7749, -122.4194, 14)).toBe(false); // San Francisco
    expect(isNullIslandWithPrecision(51.4778, 0.0001, 14)).toBe(false);    // Greenwich, real lat
    // Coarsest offset is ~0.21° (10 bits) — still nowhere near a populated coordinate.
    expect(isNullIslandWithPrecision(1.0, 1.0, 10)).toBe(false);
  });

  it('returns false for missing / non-finite coordinates', () => {
    expect(isNullIslandWithPrecision(null, 0, 14)).toBe(false);
    expect(isNullIslandWithPrecision(0, undefined, 14)).toBe(false);
    expect(isNullIslandWithPrecision(NaN, 0, 14)).toBe(false);
  });
});
