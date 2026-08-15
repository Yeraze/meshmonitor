/**
 * Coverage sweep (#4727).
 *
 * The output is a polygon a user will read as "my node reaches here", so the
 * assertions concentrate on what the polygon CLAIMS: that reach is
 * first-failure rather than farthest-success, that a blocked radial is shorter
 * than a clear one, and that the caveats travel with the numbers instead of
 * being left to the UI to remember.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Plain recording function rather than `vi.fn()`.
 *
 * With a `vi.fn` here the mock received a spurious ZERO-ARGUMENT call from
 * vitest's spy machinery in addition to the real one, which made
 * `mock.calls`-based assertions read as a bug in the sweep. Verified by
 * swapping in a plain function: the extra call disappears and the counts are
 * exactly what `computeCoverage` performed.
 */
const sampleCalls: Array<Array<{ lat: number; lng: number }>> = [];
let sampleImpl: (pts: Array<{ lat: number; lng: number }>) => (number | null)[] = () => [];

vi.mock('../elevationProvider.js', () => ({
  resolveProvider: () => ({
    type: 'terrarium',
    sample: async (pts: Array<{ lat: number; lng: number }>) => {
      sampleCalls.push(pts);
      return sampleImpl(pts);
    },
  }),
}));

import {
  computeCoverage,
  analyseRadial,
  clampCoverageParams,
  modelAssumptions,
  MAX_RADIUS_KM,
  MAX_AZIMUTHS,
  type CoverageParams,
} from './coverageSweep.js';
import type { TerrainSample } from './propagation.js';

/**
 * Deliberately tighter than a real LoRa link budget.
 *
 * At a genuine -130 dBm sensitivity the margin is so large that a 600 m ridge
 * at 10 km STILL closes (~42 dB of diffraction against ~53 dB of margin), so
 * every obstruction assertion below would pass without testing anything. This
 * budget keeps the physics honest while putting obstructions inside the range
 * where they decide the outcome.
 */
const budget = {
  txPowerDbm: 20, txGainDbi: 2, rxGainDbi: 2, lossesDb: 1, sensitivityDbm: -110,
};

const params: CoverageParams = {
  origin: { lat: 30.2672, lng: -97.7431 },
  txHeightM: 10,
  rxHeightM: 2,
  frequencyHz: 915e6,
  budget,
  radiusKm: 10,
  azimuthCount: 8,
  samplesPerRadial: 24,
};

/** Terrain profile at a constant elevation. */
function flat(totalM: number, n: number, elevation: number | null = 0): TerrainSample[] {
  return Array.from({ length: n }, (_, i) => ({
    distance: (totalM * i) / (n - 1),
    elevation,
  }));
}

beforeEach(() => { sampleCalls.length = 0; sampleImpl = () => []; });

describe('clampCoverageParams', () => {
  it('bounds an unbounded request rather than scanning the world', () => {
    const c = clampCoverageParams({ radiusKm: 9999, azimuthCount: 100000, samplesPerRadial: 99999 });
    expect(c.radiusKm).toBe(MAX_RADIUS_KM);
    expect(c.azimuthCount).toBe(MAX_AZIMUTHS);
    expect(c.samplesPerRadial).toBe(256);
  });

  it('defaults nonsense instead of rejecting', () => {
    const c = clampCoverageParams({ radiusKm: NaN, azimuthCount: undefined, samplesPerRadial: 'x' as never });
    expect(c.radiusKm).toBe(15);
    expect(c.azimuthCount).toBe(72);
    expect(c.samplesPerRadial).toBe(96);
  });

  it('floors a request to a workable minimum', () => {
    const c = clampCoverageParams({ radiusKm: 0, azimuthCount: 1, samplesPerRadial: 2 });
    expect(c.radiusKm).toBe(1);
    expect(c.azimuthCount).toBe(8);
    expect(c.samplesPerRadial).toBe(16);
  });
});

describe('modelAssumptions', () => {
  it('states that this is modelled, not measured', () => {
    // The single most important sentence in the feature.
    const a = modelAssumptions({ txHeightM: 10, rxHeightM: 2 }).join(' ');
    expect(a).toMatch(/model, not measured/i);
  });

  it('names what is NOT modelled', () => {
    const a = modelAssumptions({ txHeightM: 10, rxHeightM: 2 }).join(' ');
    expect(a).toMatch(/buildings/i);
    expect(a).toMatch(/foliage/i);
  });

  it('states the assumed antenna heights, since they drive the result', () => {
    const a = modelAssumptions({ txHeightM: 30, rxHeightM: 5 }).join(' ');
    expect(a).toContain('30 m');
    expect(a).toContain('5 m');
  });
});

describe('analyseRadial', () => {
  const p = { frequencyHz: 915e6, txHeightM: 10, rxHeightM: 2, budget };

  it('reports the full radius when the link never fails', () => {
    const r = analyseRadial(flat(2000, 24), p, 0, 2);
    expect(r.limitedByRadius).toBe(true);
    expect(r.reachKm).toBe(2);
    expect(r.reachablePocketsBeyond).toBe(false);
  });

  it('stops at the first failure, not the farthest success', () => {
    // A wall at mid-radial, then clear ground beyond. Reporting the farthest
    // closing sample would draw a polygon implying the blocked middle works.
    const samples = flat(20_000, 41).map((s, i) => ({
      ...s,
      elevation: i >= 18 && i <= 22 ? 600 : 0,
    }));
    const r = analyseRadial(samples, p, 90, 20);

    expect(r.limitedByRadius).toBe(false);
    expect(r.reachKm).toBeLessThan(20);
    // The wall is around 9 km out; reach must stop at it, not past it.
    expect(r.reachKm).toBeLessThanOrEqual(11);
  });

  it('flags reachable pockets beyond the first failure rather than hiding them', () => {
    // A modest ridge blocks the low ground behind it, but a tall peak further
    // out is still visible OVER that ridge — the mountaintop-repeater case.
    // A wall alone would not do: every longer profile still contains it, so
    // nothing past it closes and there is no pocket to find.
    const samples = flat(20_000, 41).map((s, i) => ({
      ...s,
      elevation: i >= 18 && i <= 22 ? 300 : (i >= 38 ? 1500 : 0),
    }));
    const r = analyseRadial(samples, p, 90, 20);

    expect(r.limitedByRadius).toBe(false);      // the low ground behind is lost
    expect(r.reachablePocketsBeyond).toBe(true); // but the peak is reachable
  });

  it('propagates DEM gaps so the caller can qualify the answer', () => {
    const samples = flat(5000, 24).map((s, i) => ({ ...s, elevation: i === 10 ? null : s.elevation }));
    expect(analyseRadial(samples, p, 0, 5).hasDataGaps).toBe(true);
  });

  it('gives a blocked radial a shorter reach than a clear one', () => {
    const clear = analyseRadial(flat(20_000, 41), p, 0, 20);
    const ridge = flat(20_000, 41).map((s, i) => ({ ...s, elevation: i >= 10 && i <= 14 ? 800 : 0 }));
    const blocked = analyseRadial(ridge, p, 0, 20);

    expect(blocked.reachKm).toBeLessThan(clear.reachKm);
  });
});

describe('computeCoverage', () => {
  /** Every sampled point at one elevation. */
  const allFlat = (elev: number | null) => {
    sampleImpl = (pts) => new Array(pts.length).fill(elev);
  };

  it('produces one radial per azimuth, evenly spaced', async () => {
    allFlat(0);
    const r = await computeCoverage(params, undefined);

    expect(r.radials).toHaveLength(8);
    expect(r.radials.map((x) => x.bearingDeg)).toEqual([0, 45, 90, 135, 180, 225, 270, 315]);
  });

  it('samples every radial in ONE provider call so tile grouping works', async () => {
    // Per-radial calls would refetch shared tiles across adjacent azimuths.
    allFlat(0);
    await computeCoverage(params, undefined);

    expect(sampleCalls).toHaveLength(1);
    expect(sampleCalls[0]).toHaveLength(8 * 24);
  });

  it('carries the assumptions in the payload, not just the UI', async () => {
    allFlat(0);
    const r = await computeCoverage(params, undefined);

    expect(r.model).toBe('fresnel-path-loss');
    expect(r.assumptions.join(' ')).toMatch(/not measured/i);
  });

  it('clamps an over-large request', async () => {
    allFlat(0);
    const r = await computeCoverage({ ...params, radiusKm: 9999, azimuthCount: 100000 }, undefined);

    expect(r.radiusKm).toBe(MAX_RADIUS_KM);
    expect(r.radials).toHaveLength(MAX_AZIMUTHS);
  });

  it('still answers when elevation sampling fails outright', async () => {
    // A dead DEM source degrades to a free-space-only answer flagged with data
    // gaps, rather than failing the whole request.
    sampleImpl = () => { throw new Error('provider exploded'); };
    const r = await computeCoverage(params, undefined);

    expect(r.radials).toHaveLength(8);
    expect(r.radials.every((x) => x.hasDataGaps)).toBe(true);
  });

  it('shortens reach on the side facing a ridge', async () => {
    // Terrain high to the east (bearing 90) only. That radial must come back
    // shorter than the westward one.
    sampleImpl = (pts) => pts.map((p) => (p.lng > params.origin.lng + 0.005 ? 900 : 0));

    const r = await computeCoverage({ ...params, radiusKm: 20 }, undefined);
    const east = r.radials.find((x) => x.bearingDeg === 90)!;
    const west = r.radials.find((x) => x.bearingDeg === 270)!;

    expect(east.reachKm).toBeLessThan(west.reachKm);
  });
});
