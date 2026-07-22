import { describe, it, expect } from 'vitest';
import { aglFromNodeAltitude, analyzeLinkProfile } from './linkProfile';
import { earthBulgeMeters } from './linkBudget';
import type { ElevationSample } from '../types/elevation';

const FREQ_MHZ = 915;

/** Build a flat 0..totalM path with `count` evenly spaced samples and the given elevation profile. */
function makeSamples(totalM: number, count: number, elevationAt: (i: number, distanceM: number) => number | null): ElevationSample[] {
  const samples: ElevationSample[] = [];
  for (let i = 0; i < count; i++) {
    const distance = (totalM * i) / (count - 1);
    samples.push({ distance, lat: 0, lng: i, elevation: elevationAt(i, distance) });
  }
  return samples;
}

describe('analyzeLinkProfile', () => {
  it('produces one output point per input sample, monotonic distanceKm, totalDistanceKm from last sample', () => {
    const samples = makeSamples(10000, 11, () => 0);
    const analysis = analyzeLinkProfile(samples, {
      freqMhz: FREQ_MHZ,
      antennaHeightAglAM: 10,
      antennaHeightAglBM: 10,
    });
    expect(analysis.points).toHaveLength(samples.length);
    expect(analysis.totalDistanceKm).toBeCloseTo(10, 6);
    for (let i = 1; i < analysis.points.length; i++) {
      expect(analysis.points[i].distanceKm).toBeGreaterThanOrEqual(analysis.points[i - 1].distanceKm);
    }
  });

  it('classifies a clear link: flat terrain well below LOS, tall masts', () => {
    // Flat 0m terrain, 10km path, 30m masts both ends (well above the ~28.6m
    // Fresnel radius at the midpoint) -> minimal Fresnel intrusion.
    const samples = makeSamples(10000, 11, () => 0);
    const analysis = analyzeLinkProfile(samples, {
      freqMhz: FREQ_MHZ,
      antennaHeightAglAM: 30,
      antennaHeightAglBM: 30,
    });
    expect(analysis.verdict).toBe('clear');
    expect(analysis.worst).not.toBeNull();
    expect(analysis.fresnelClearancePct).toBeGreaterThanOrEqual(60);
  });

  it('classifies a marginal link: LOS clear everywhere but pokes into the Fresnel zone', () => {
    // Same flat terrain/path, but short 10m masts -> LOS clears the flat
    // terrain (clearance >= 0) yet the curvature bulge eats deep into the
    // Fresnel zone at the midpoint (ratio < 0.6).
    const samples = makeSamples(10000, 11, () => 0);
    const analysis = analyzeLinkProfile(samples, {
      freqMhz: FREQ_MHZ,
      antennaHeightAglAM: 10,
      antennaHeightAglBM: 10,
    });
    expect(analysis.verdict).toBe('marginal');
    expect(analysis.worst).not.toBeNull();
    expect(analysis.worst!.clearanceM).toBeGreaterThanOrEqual(0);
    expect(analysis.worst!.clearanceRatio).toBeLessThan(0.6);
  });

  it('classifies an obstructed link: a mid-path hill pokes above the LOS', () => {
    const samples = makeSamples(10000, 11, (i) => (i === 5 ? 50 : 0));
    const analysis = analyzeLinkProfile(samples, {
      freqMhz: FREQ_MHZ,
      antennaHeightAglAM: 10,
      antennaHeightAglBM: 10,
    });
    expect(analysis.verdict).toBe('obstructed');
    expect(analysis.worst).not.toBeNull();
    expect(analysis.worst!.clearanceM).toBeLessThan(0);
  });

  it('raising antenna AGL at both endpoints flips an obstructed link to clear', () => {
    const samples = makeSamples(10000, 11, (i) => (i === 5 ? 50 : 0));
    const obstructed = analyzeLinkProfile(samples, {
      freqMhz: FREQ_MHZ,
      antennaHeightAglAM: 10,
      antennaHeightAglBM: 10,
    });
    expect(obstructed.verdict).toBe('obstructed');

    const raised = analyzeLinkProfile(samples, {
      freqMhz: FREQ_MHZ,
      antennaHeightAglAM: 100,
      antennaHeightAglBM: 100,
    });
    expect(raised.verdict).toBe('clear');
    expect(raised.worst!.clearanceM).toBeGreaterThan(0);
  });

  it('applies earth-curvature bulge: mid-path effectiveTerrain > raw terrain, and a larger k lowers the bulge', () => {
    // 33.3km path matching the locked earthBulgeMeters reference fixtures
    // (d1=d2=16650m at the midpoint).
    const samples = makeSamples(33300, 3, () => 0);

    const defaultK = analyzeLinkProfile(samples, {
      freqMhz: FREQ_MHZ,
      antennaHeightAglAM: 1,
      antennaHeightAglBM: 1,
    });
    const midDefault = defaultK.points[1];
    expect(midDefault.terrain).toBe(0);
    expect(midDefault.effectiveTerrain).not.toBeNull();
    expect(midDefault.effectiveTerrain!).toBeGreaterThan(midDefault.terrain!);
    expect(midDefault.effectiveTerrain!).toBeCloseTo(earthBulgeMeters(16650, 16650), 2);

    const kEqualsOne = analyzeLinkProfile(samples, {
      freqMhz: FREQ_MHZ,
      antennaHeightAglAM: 1,
      antennaHeightAglBM: 1,
      kFactor: 1,
    });
    const midKEqualsOne = kEqualsOne.points[1];
    expect(midKEqualsOne.effectiveTerrain!).toBeCloseTo(earthBulgeMeters(16650, 16650, 1), 2);

    // Larger k (the default 4/3) produces a smaller bulge than k=1.
    expect(midDefault.effectiveTerrain!).toBeLessThan(midKEqualsOne.effectiveTerrain!);
  });

  it('excludes null-elevation samples from worst-case/verdict classification', () => {
    // A very obstructive hill sits under a null-elevation sample; a much
    // smaller (non-obstructive) bump sits at another interior sample. The
    // null sample must not be selected as `worst`, and must not force an
    // obstructed verdict.
    const samples = makeSamples(10000, 11, (i) => {
      if (i === 3) return null; // would otherwise dominate the worst-case
      if (i === 7) return 5; // small bump, still under a 30m LOS
      return 0;
    });
    const analysis = analyzeLinkProfile(samples, {
      freqMhz: FREQ_MHZ,
      antennaHeightAglAM: 30,
      antennaHeightAglBM: 30,
    });
    expect(analysis.worst).not.toBeNull();
    expect(analysis.worst!.distanceKm).not.toBeCloseTo(samples[3].distance / 1000, 6);
    expect(analysis.points[3].terrain).toBeNull();
    expect(analysis.points[3].effectiveTerrain).toBeNull();
    expect(analysis.points[3].obstructed).toBe(false);
    expect(Number.isNaN(analysis.fresnelClearancePct)).toBe(false);
  });

  it('handles an all-null profile without throwing: worst null, verdict clear', () => {
    const samples = makeSamples(10000, 11, () => null);
    expect(() => analyzeLinkProfile(samples, {
      freqMhz: FREQ_MHZ,
      antennaHeightAglAM: 10,
      antennaHeightAglBM: 10,
    })).not.toThrow();

    const analysis = analyzeLinkProfile(samples, {
      freqMhz: FREQ_MHZ,
      antennaHeightAglAM: 10,
      antennaHeightAglBM: 10,
    });
    expect(analysis.worst).toBeNull();
    expect(analysis.verdict).toBe('clear');
    expect(analysis.points).toHaveLength(samples.length);
    for (const p of analysis.points) {
      expect(p.terrain).toBeNull();
      expect(p.effectiveTerrain).toBeNull();
      expect(p.obstructed).toBe(false);
    }
  });

  it('handles an empty sample array without throwing', () => {
    expect(() => analyzeLinkProfile([], {
      freqMhz: FREQ_MHZ,
      antennaHeightAglAM: 10,
      antennaHeightAglBM: 10,
    })).not.toThrow();
    const analysis = analyzeLinkProfile([], {
      freqMhz: FREQ_MHZ,
      antennaHeightAglAM: 10,
      antennaHeightAglBM: 10,
    });
    expect(analysis.points).toHaveLength(0);
    expect(analysis.totalDistanceKm).toBe(0);
    expect(analysis.worst).toBeNull();
    expect(analysis.verdict).toBe('clear');
  });

  it('handles zero/negative total distance (coincident endpoints) without NaN', () => {
    const samples: ElevationSample[] = [
      { distance: 0, lat: 0, lng: 0, elevation: 0 },
      { distance: 0, lat: 0, lng: 0, elevation: 0 },
    ];
    const analysis = analyzeLinkProfile(samples, {
      freqMhz: FREQ_MHZ,
      antennaHeightAglAM: 10,
      antennaHeightAglBM: 10,
    });
    expect(analysis.totalDistanceKm).toBe(0);
    for (const p of analysis.points) {
      expect(Number.isNaN(p.los)).toBe(false);
      expect(Number.isNaN(p.fresnelLower)).toBe(false);
    }
  });

  it('applies AGL at the endpoints to compute antennaTopAM/antennaTopBM', () => {
    const samples = makeSamples(10000, 3, (i) => (i === 0 ? 100 : i === 2 ? 200 : 150));
    const analysis = analyzeLinkProfile(samples, {
      freqMhz: FREQ_MHZ,
      antennaHeightAglAM: 5,
      antennaHeightAglBM: 15,
    });
    expect(analysis.antennaTopAM).toBeCloseTo(105, 6);
    expect(analysis.antennaTopBM).toBeCloseTo(215, 6);
  });
  describe('aglFromNodeAltitude', () => {
    it('returns rounded altitude-minus-ground when both are finite and the difference is sane', () => {
      expect(aglFromNodeAltitude(130, 100)).toBe(30);
      expect(aglFromNodeAltitude(102.6, 100)).toBe(3);
    });

    it('returns null below the 0.5 m floor (datum error must not shrink the default)', () => {
      expect(aglFromNodeAltitude(100.2, 100)).toBeNull();
      expect(aglFromNodeAltitude(95, 100)).toBeNull();
    });

    it('returns null when either value is missing or non-finite', () => {
      expect(aglFromNodeAltitude(undefined, 100)).toBeNull();
      expect(aglFromNodeAltitude(null, 100)).toBeNull();
      expect(aglFromNodeAltitude(130, null)).toBeNull();
      expect(aglFromNodeAltitude(130, undefined)).toBeNull();
      expect(aglFromNodeAltitude(NaN, 100)).toBeNull();
      expect(aglFromNodeAltitude(130, NaN)).toBeNull();
    });
  });
});

