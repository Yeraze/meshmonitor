/**
 * Sky-view + DOP compute tests (#4729).
 *
 * Fully deterministic: a fixed GPS TLE fixture (`gpsTleFixture.ts`) + a fixed
 * reference `Date` + the Florida reference observer. No network. Reference
 * values were validated against a live CelesTrak `gps-ops` snapshot with the
 * same math pipeline (see PR notes).
 *
 * Reference (Florida lat 26.12, lon -80.14, alt 0 km, 5° mask,
 * 2026-08-18T12:00:00Z): 11 visible, ranges ~20449–24238 km, elevations
 * 15.5–67.9°, GDOP ≈ 2.00.
 */

import { describe, it, expect } from 'vitest';
import { computeSkyView, computeDop, invert4x4, type Tle } from './skyView.js';
import { GPS_TLE_FIXTURE, GPS_TLE_FIXTURE_DATE } from './gpsTleFixture.js';

const FLORIDA = { latDeg: 26.12, lonDeg: -80.14, altKm: 0 };

describe('computeSkyView (Florida reference)', () => {
  const result = computeSkyView({
    tles: GPS_TLE_FIXTURE,
    observer: FLORIDA,
    date: GPS_TLE_FIXTURE_DATE,
    elevationMaskDeg: 5,
  });

  it('finds a plausible number of visible satellites', () => {
    expect(result.visibleCount).toBeGreaterThan(0);
    expect(result.visibleCount).toBe(result.satellites.length);
    // Whole GPS constellation over one point at 5° mask: physically ~8–12.
    expect(result.visibleCount).toBeGreaterThanOrEqual(8);
    expect(result.visibleCount).toBeLessThanOrEqual(12);
  });

  it('every visible satellite has physically-correct az/el/range', () => {
    for (const sat of result.satellites) {
      expect(sat.elDeg).toBeGreaterThanOrEqual(5);
      expect(sat.elDeg).toBeLessThanOrEqual(90);
      expect(sat.azDeg).toBeGreaterThanOrEqual(0);
      expect(sat.azDeg).toBeLessThan(360);
      // GPS MEO slant range from the ground is ~20,000–25,500 km.
      expect(sat.rangeKm).toBeGreaterThan(20000);
      expect(sat.rangeKm).toBeLessThan(25500);
      expect(typeof sat.name).toBe('string');
    }
  });

  it('produces finite, positive DOP for good geometry (GDOP ~1.3–3)', () => {
    expect(result.dop).not.toBeNull();
    const dop = result.dop!;
    for (const v of [dop.gdop, dop.pdop, dop.hdop, dop.vdop]) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
    // Ordering identities: GDOP >= PDOP >= HDOP, and GDOP >= VDOP.
    expect(dop.gdop).toBeGreaterThanOrEqual(dop.pdop);
    expect(dop.pdop).toBeGreaterThanOrEqual(dop.hdop);
    expect(dop.gdop).toBeGreaterThanOrEqual(dop.vdop);
    // Good geometry with the full constellation.
    expect(dop.gdop).toBeGreaterThan(1.3);
    expect(dop.gdop).toBeLessThan(3);
  });

  it('matches the captured reference values (regression guard)', () => {
    expect(result.visibleCount).toBe(11);
    const dop = result.dop!;
    expect(dop.gdop).toBeCloseTo(2.0, 1);
    expect(dop.pdop).toBeCloseTo(1.77, 1);
    expect(dop.hdop).toBeCloseTo(0.79, 1);
    expect(dop.vdop).toBeCloseTo(1.58, 1);
    const ranges = result.satellites.map((s) => s.rangeKm);
    expect(Math.min(...ranges)).toBeGreaterThan(20000);
    expect(Math.min(...ranges)).toBeLessThan(21000);
    expect(Math.max(...ranges)).toBeGreaterThan(23500);
    expect(Math.max(...ranges)).toBeLessThan(25000);
  });
});

describe('computeSkyView edge cases', () => {
  it('a high elevation mask hides everything (empty, DOP null)', () => {
    const result = computeSkyView({
      tles: GPS_TLE_FIXTURE,
      observer: FLORIDA,
      date: GPS_TLE_FIXTURE_DATE,
      elevationMaskDeg: 89,
    });
    expect(result.visibleCount).toBe(0);
    expect(result.satellites).toEqual([]);
    expect(result.dop).toBeNull();
  });

  it('skips malformed TLEs without throwing', () => {
    const withGarbage: Tle[] = [
      ...GPS_TLE_FIXTURE.slice(0, 4),
      { name: 'GARBAGE', line1: 'not a tle', line2: 'also not a tle' },
    ];
    expect(() =>
      computeSkyView({
        tles: withGarbage,
        observer: FLORIDA,
        date: GPS_TLE_FIXTURE_DATE,
        elevationMaskDeg: 5,
      })
    ).not.toThrow();
  });

  it('empty TLE set yields empty result with null DOP', () => {
    const result = computeSkyView({
      tles: [],
      observer: FLORIDA,
      date: GPS_TLE_FIXTURE_DATE,
      elevationMaskDeg: 5,
    });
    expect(result.visibleCount).toBe(0);
    expect(result.dop).toBeNull();
  });
});

describe('computeDop', () => {
  it('returns null with fewer than 4 satellites', () => {
    expect(computeDop([])).toBeNull();
    expect(computeDop([{ azDeg: 10, elDeg: 30 }])).toBeNull();
    expect(
      computeDop([
        { azDeg: 10, elDeg: 30 },
        { azDeg: 120, elDeg: 45 },
        { azDeg: 250, elDeg: 20 },
      ])
    ).toBeNull();
  });

  it('returns finite DOP with 4 well-spread satellites', () => {
    const dop = computeDop([
      { azDeg: 0, elDeg: 70 },
      { azDeg: 90, elDeg: 20 },
      { azDeg: 200, elDeg: 30 },
      { azDeg: 300, elDeg: 15 },
    ]);
    expect(dop).not.toBeNull();
    for (const v of [dop!.gdop, dop!.pdop, dop!.hdop, dop!.vdop]) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
  });

  it('returns null for a degenerate (all-collinear) geometry', () => {
    // Four satellites at the same az/el — the design matrix is rank-deficient.
    const sats = Array.from({ length: 4 }, () => ({ azDeg: 45, elDeg: 45 }));
    expect(computeDop(sats)).toBeNull();
  });
});

describe('invert4x4', () => {
  it('inverts the identity to itself', () => {
    const I = [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ];
    expect(invert4x4(I)).toEqual(I);
  });

  it('returns null for a singular matrix', () => {
    const singular = [
      [1, 2, 3, 4],
      [2, 4, 6, 8], // row 2 = 2 * row 1
      [1, 0, 0, 0],
      [0, 1, 0, 0],
    ];
    expect(invert4x4(singular)).toBeNull();
  });

  it('produces a true inverse (M * M^-1 = I)', () => {
    const M = [
      [4, 7, 2, 1],
      [3, 6, 1, 2],
      [2, 5, 3, 0],
      [1, 1, 0, 4],
    ];
    const inv = invert4x4(M)!;
    expect(inv).not.toBeNull();
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) sum += M[i][k] * inv[k][j];
        expect(sum).toBeCloseTo(i === j ? 1 : 0, 9);
      }
    }
  });
});
