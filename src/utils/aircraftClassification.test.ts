/**
 * Pure likely-aircraft classifier tests (#5364/#5365 Phase 1 WP1, spec §6).
 */
import { describe, it, expect } from 'vitest';
import {
  classifyAircraft,
  parseAircraftSettings,
  aircraftHysteresisM,
  isAircraftTransition,
  normalizeLikelyAircraft,
  isAircraftDisplayMode,
  formatAircraftSummary,
  DEFAULT_AIRCRAFT_AGL_THRESHOLD_M,
  DEFAULT_AIRCRAFT_MSL_THRESHOLD_M,
  AIRCRAFT_AGL_RANGE,
  AIRCRAFT_MSL_RANGE,
  type AircraftSettings,
} from './aircraftClassification.js';

const defaultSettings: AircraftSettings = {
  enabled: true,
  aglThresholdM: DEFAULT_AIRCRAFT_AGL_THRESHOLD_M,
  mslThresholdM: DEFAULT_AIRCRAFT_MSL_THRESHOLD_M,
};

describe('classifyAircraft', () => {
  it('mountaintop: alt 4300, ground 4250, T=500 -> false, basis agl, hag 50', () => {
    const result = classifyAircraft({ altitudeM: 4300, groundElevationM: 4250, settings: defaultSettings });
    expect(result).toEqual({ likelyAircraft: false, basis: 'agl', groundElevation: 4250, heightAboveGround: 50 });
  });

  it('3000m AGL: alt 3200, ground 200 -> true, hag 3000', () => {
    const result = classifyAircraft({ altitudeM: 3200, groundElevationM: 200, settings: defaultSettings });
    expect(result.likelyAircraft).toBe(true);
    expect(result.basis).toBe('agl');
    expect(result.heightAboveGround).toBe(3000);
  });

  it('elevation null, above MSL: alt 6000, ground null -> true, basis msl, hag null', () => {
    const result = classifyAircraft({ altitudeM: 6000, groundElevationM: null, settings: defaultSettings });
    expect(result).toEqual({ likelyAircraft: true, basis: 'msl', groundElevation: null, heightAboveGround: null });
  });

  it('elevation null, below MSL: alt 4300, ground null -> false, msl', () => {
    const result = classifyAircraft({ altitudeM: 4300, groundElevationM: null, settings: defaultSettings });
    expect(result.likelyAircraft).toBe(false);
    expect(result.basis).toBe('msl');
  });

  it.each([null, undefined, NaN])('altitude missing (%p) -> null, unknown', (altitudeM) => {
    const result = classifyAircraft({ altitudeM, groundElevationM: 200, settings: defaultSettings });
    expect(result.likelyAircraft).toBeNull();
    expect(result.basis).toBe('unknown');
    expect(result.heightAboveGround).toBeNull();
  });

  it('altitude missing still passes through a finite ground elevation', () => {
    const result = classifyAircraft({ altitudeM: null, groundElevationM: 200, settings: defaultSettings });
    expect(result.groundElevation).toBe(200);
  });

  it('exact threshold (hag === T) -> false (strict >)', () => {
    const result = classifyAircraft({ altitudeM: 700, groundElevationM: 200, settings: defaultSettings });
    expect(result.heightAboveGround).toBe(500);
    expect(result.likelyAircraft).toBe(false);
  });

  it('negative hag -> false', () => {
    const result = classifyAircraft({ altitudeM: 100, groundElevationM: 200, settings: defaultSettings });
    expect(result.heightAboveGround).toBe(-100);
    expect(result.likelyAircraft).toBe(false);
  });

  describe('AGL hysteresis (previous flagged on agl, T=500, H=50)', () => {
    it('hag 460 (> 450 floor) stays flagged', () => {
      const result = classifyAircraft({
        altitudeM: 660,
        groundElevationM: 200,
        settings: defaultSettings,
        previous: { likelyAircraft: true, basis: 'agl' },
      });
      expect(result.heightAboveGround).toBe(460);
      expect(result.likelyAircraft).toBe(true);
    });

    it('hag 440 (<= 450 floor) clears', () => {
      const result = classifyAircraft({
        altitudeM: 640,
        groundElevationM: 200,
        settings: defaultSettings,
        previous: { likelyAircraft: true, basis: 'agl' },
      });
      expect(result.heightAboveGround).toBe(440);
      expect(result.likelyAircraft).toBe(false);
    });

    it('previous flagged on msl (basis change): agl hag 460 uses the strict threshold, not hysteresis', () => {
      const result = classifyAircraft({
        altitudeM: 660,
        groundElevationM: 200,
        settings: defaultSettings,
        previous: { likelyAircraft: true, basis: 'msl' },
      });
      expect(result.heightAboveGround).toBe(460);
      expect(result.likelyAircraft).toBe(false);
    });
  });

  describe('MSL hysteresis (previous flagged on msl, T=5000, H=500)', () => {
    it('altitude 4600 (> 4500 floor) stays flagged', () => {
      const result = classifyAircraft({
        altitudeM: 4600,
        groundElevationM: null,
        settings: defaultSettings,
        previous: { likelyAircraft: true, basis: 'msl' },
      });
      expect(result.likelyAircraft).toBe(true);
    });

    it('altitude 4400 (<= 4500 floor) clears', () => {
      const result = classifyAircraft({
        altitudeM: 4400,
        groundElevationM: null,
        settings: defaultSettings,
        previous: { likelyAircraft: true, basis: 'msl' },
      });
      expect(result.likelyAircraft).toBe(false);
    });
  });
});

describe('aircraftHysteresisM', () => {
  it('is max(50, round(0.1 * threshold))', () => {
    expect(aircraftHysteresisM(500)).toBe(50);
    expect(aircraftHysteresisM(5000)).toBe(500);
    expect(aircraftHysteresisM(100)).toBe(50); // floor at 50
    expect(aircraftHysteresisM(20000)).toBe(2000);
  });
});

describe('parseAircraftSettings', () => {
  it('nulls -> defaults', () => {
    expect(parseAircraftSettings({ enabled: null, aglThresholdM: null, mslThresholdM: null })).toEqual({
      enabled: true,
      aglThresholdM: DEFAULT_AIRCRAFT_AGL_THRESHOLD_M,
      mslThresholdM: DEFAULT_AIRCRAFT_MSL_THRESHOLD_M,
    });
  });

  it('missing keys -> defaults', () => {
    expect(parseAircraftSettings({})).toEqual({
      enabled: true,
      aglThresholdM: DEFAULT_AIRCRAFT_AGL_THRESHOLD_M,
      mslThresholdM: DEFAULT_AIRCRAFT_MSL_THRESHOLD_M,
    });
  });

  it("'abc' -> default", () => {
    const result = parseAircraftSettings({ aglThresholdM: 'abc', mslThresholdM: 'xyz' });
    expect(result.aglThresholdM).toBe(DEFAULT_AIRCRAFT_AGL_THRESHOLD_M);
    expect(result.mslThresholdM).toBe(DEFAULT_AIRCRAFT_MSL_THRESHOLD_M);
  });

  it('10 -> clamped to the AGL range minimum (50)', () => {
    expect(parseAircraftSettings({ aglThresholdM: '10' }).aglThresholdM).toBe(AIRCRAFT_AGL_RANGE.min);
  });

  it('99999 -> clamped to the AGL range maximum (20000)', () => {
    expect(parseAircraftSettings({ aglThresholdM: '99999' }).aglThresholdM).toBe(AIRCRAFT_AGL_RANGE.max);
  });

  it('MSL threshold clamps into its own range', () => {
    expect(parseAircraftSettings({ mslThresholdM: '10' }).mslThresholdM).toBe(AIRCRAFT_MSL_RANGE.min);
    expect(parseAircraftSettings({ mslThresholdM: '99999' }).mslThresholdM).toBe(AIRCRAFT_MSL_RANGE.max);
  });

  it("'false' -> disabled", () => {
    expect(parseAircraftSettings({ enabled: 'false' }).enabled).toBe(false);
  });

  it("'true' or anything else -> enabled", () => {
    expect(parseAircraftSettings({ enabled: 'true' }).enabled).toBe(true);
    expect(parseAircraftSettings({ enabled: 'garbage' }).enabled).toBe(true);
  });
});

describe('isAircraftTransition', () => {
  it.each([
    [null, true, true],
    [false, true, true],
    [true, true, false],
    [true, false, false],
    [null, null, false],
    [undefined, true, true],
  ])('prev=%p next=%p -> %p', (prev, next, expected) => {
    expect(isAircraftTransition(prev, next)).toBe(expected);
  });
});

describe('normalizeLikelyAircraft', () => {
  it.each([
    [0, false],
    [1, true],
    [true, true],
    [false, false],
    [null, null],
    [undefined, null],
  ])('%p -> %p', (input, expected) => {
    expect(normalizeLikelyAircraft(input)).toBe(expected);
  });
});

describe('isAircraftDisplayMode', () => {
  it.each(['show', 'mark', 'hide'])('%s is valid', (mode) => {
    expect(isAircraftDisplayMode(mode)).toBe(true);
  });

  it.each([null, undefined, '', 'bogus', 123, {}])('%p is invalid', (v) => {
    expect(isAircraftDisplayMode(v)).toBe(false);
  });
});

describe('formatAircraftSummary', () => {
  const t = (key: string, defaultValue: string, options?: Record<string, unknown>) => {
    let result = defaultValue;
    if (options) {
      for (const [k, v] of Object.entries(options)) {
        result = result.replace(`{{${k}}}`, String(v));
      }
    }
    return result;
  };

  it('AGL, at or above 1 km -> "X.X km above ground"', () => {
    const summary = formatAircraftSummary({ aircraftBasis: 'agl', heightAboveGround: 1200 }, t as any);
    expect(summary).toBe('Likely aircraft · 1.2 km above ground');
  });

  it('AGL, sub-km -> "N m above ground"', () => {
    const summary = formatAircraftSummary({ aircraftBasis: 'agl', heightAboveGround: 850 }, t as any);
    expect(summary).toBe('Likely aircraft · 850 m above ground');
  });

  it('MSL -> "X.X km above sea level"', () => {
    const summary = formatAircraftSummary({ aircraftBasis: 'msl', altitude: 6100 }, t as any);
    expect(summary).toBe('Likely aircraft · 6.1 km above sea level');
  });
});
