/**
 * RF propagation model (#4727).
 *
 * This module outputs numbers a user will act on — "can my node reach that
 * hill?" — so the tests check the physics against INDEPENDENT references
 * rather than against the implementation restated: the textbook km/GHz forms,
 * and published values (6 dB grazing diffraction, ~91.7 dB FSPL at 915 MHz /
 * 1 km). A test that only re-derives the same expression would confirm the
 * code is self-consistent while it was uniformly wrong.
 */
import { describe, it, expect } from 'vitest';
import {
  wavelengthM,
  fresnelRadiusM,
  earthBulgeM,
  freeSpaceLossDb,
  knifeEdgeLossDb,
  evaluateLink,
  DEFAULT_K_FACTOR,
  type TerrainSample,
} from './propagation.js';

const MHZ_915 = 915e6;

/** Flat ground at a fixed elevation, `n` samples over `totalM`. */
function flatProfile(totalM: number, elevation = 0, n = 64): TerrainSample[] {
  return Array.from({ length: n }, (_, i) => ({
    distance: (totalM * i) / (n - 1),
    elevation,
  }));
}

const budget = {
  txPowerDbm: 30,
  txGainDbi: 3,
  rxGainDbi: 3,
  lossesDb: 1,
  sensitivityDbm: -130,
};

describe('fresnelRadiusM', () => {
  it('agrees with the textbook 17.31*sqrt(d1*d2/(f*D)) km/GHz form', () => {
    // Independent check: same quantity, constants folded differently.
    const textbook = (d1Km: number, d2Km: number, fGhz: number, dKm: number) =>
      17.31 * Math.sqrt((d1Km * d2Km) / (fGhz * dKm));

    for (const [d1Km, d2Km] of [[5, 5], [1, 9], [0.5, 0.5], [20, 30]]) {
      const dKm = d1Km + d2Km;
      const si = fresnelRadiusM(wavelengthM(MHZ_915), d1Km * 1000, d2Km * 1000, dKm * 1000);
      expect(si).toBeCloseTo(textbook(d1Km, d2Km, 0.915, dKm), 1);
    }
  });

  it('matches the published ~28.6 m at 915 MHz, midpoint of a 10 km path', () => {
    expect(fresnelRadiusM(wavelengthM(MHZ_915), 5000, 5000, 10000)).toBeCloseTo(28.6, 1);
  });

  it('returns 0 for a degenerate path rather than NaN', () => {
    expect(fresnelRadiusM(0.33, 0, 0, 0)).toBe(0);
  });
});

describe('earthBulgeM', () => {
  it('agrees with the textbook d1*d2/(12.75*k) km form', () => {
    for (const [d1Km, d2Km] of [[5, 5], [15, 15], [1, 49]]) {
      const textbook = (d1Km * d2Km) / (12.75 * DEFAULT_K_FACTOR);
      expect(earthBulgeM(d1Km * 1000, d2Km * 1000)).toBeCloseTo(textbook, 1);
    }
  });

  it('is ~13 m at the midpoint of a 30 km path — not negligible', () => {
    // The reason curvature is modelled at all: ignoring this makes long links
    // look far better than they are.
    expect(earthBulgeM(15000, 15000)).toBeGreaterThan(12);
    expect(earthBulgeM(15000, 15000)).toBeLessThan(14);
  });

  it('grows with a smaller k-factor (less refraction bends less)', () => {
    expect(earthBulgeM(15000, 15000, 1)).toBeGreaterThan(earthBulgeM(15000, 15000, 4 / 3));
  });
});

describe('freeSpaceLossDb', () => {
  it('matches the published 32.44 + 20log10(d_km) + 20log10(f_MHz) form', () => {
    const textbook = (dKm: number, fMhz: number) =>
      32.44 + 20 * Math.log10(dKm) + 20 * Math.log10(fMhz);

    for (const dKm of [0.1, 1, 10, 50]) {
      expect(freeSpaceLossDb(dKm * 1000, wavelengthM(MHZ_915)))
        .toBeCloseTo(textbook(dKm, 915), 1);
    }
  });

  it('is ~91.7 dB at 915 MHz over 1 km', () => {
    expect(freeSpaceLossDb(1000, wavelengthM(MHZ_915))).toBeCloseTo(91.7, 1);
  });

  it('never reports negative loss at sub-wavelength range', () => {
    // The formula goes negative below one wavelength; "gain from being close"
    // is not something this model should hand to a link budget.
    expect(freeSpaceLossDb(0.01, wavelengthM(MHZ_915))).toBe(0);
    expect(freeSpaceLossDb(0, wavelengthM(MHZ_915))).toBe(0);
  });
});

describe('knifeEdgeLossDb', () => {
  it('is ~6 dB at grazing incidence (v = 0)', () => {
    // The classic result: an obstruction exactly on the line of sight costs
    // about 6 dB, not zero.
    expect(knifeEdgeLossDb(0)).toBeCloseTo(6.0, 1);
  });

  it('is zero when the obstruction is well clear (v <= -0.7)', () => {
    expect(knifeEdgeLossDb(-0.7)).toBe(0);
    expect(knifeEdgeLossDb(-3)).toBe(0);
  });

  it('never returns negative loss anywhere in the active range', () => {
    // Review question on #4741: could J(v) go negative just above the -0.7
    // cutoff? Swept numerically — the minimum over (-0.7, 5] is +0.536 dB at
    // v just above the boundary, so no. Asserted as a property rather than
    // wrapped in a Math.max: a clamp that can never fire is dead code that
    // would also absorb a genuine future regression in the guard threshold.
    for (let v = -0.699; v <= 5; v += 0.001) {
      expect(knifeEdgeLossDb(v)).toBeGreaterThanOrEqual(0);
    }
  });

  it('is continuous-ish across the -0.7 cutoff, stepping by well under a dB', () => {
    // The guard makes J(v) discontinuous by construction; this pins how big
    // that step is, so a future change to the threshold cannot quietly turn a
    // half-dB seam into a large one.
    expect(knifeEdgeLossDb(-0.7)).toBe(0);
    expect(knifeEdgeLossDb(-0.699)).toBeGreaterThan(0);
    expect(knifeEdgeLossDb(-0.699)).toBeLessThan(1);
  });

  it('increases monotonically as the obstruction rises', () => {
    const losses = [0, 1, 2, 3, 5].map(knifeEdgeLossDb);
    for (let i = 1; i < losses.length; i++) {
      expect(losses[i]).toBeGreaterThan(losses[i - 1]);
    }
  });
});

describe('evaluateLink', () => {
  const inputs = { frequencyHz: MHZ_915, txHeightM: 10, rxHeightM: 2 };

  it('closes a short flat path', () => {
    const r = evaluateLink(flatProfile(2000), inputs, budget);
    expect(r.closes).toBe(true);
    expect(r.marginDb).toBeGreaterThan(0);
  });

  it('charges diffraction loss on a flat path whose Fresnel zone is intruded', () => {
    // Not a bug, and worth pinning because it is counter-intuitive: with a 10 m
    // and a 2 m antenna over 2 km, the ground itself sits inside the first
    // Fresnel zone (~13 m radius at the midpoint), so the "clear" path is
    // already paying a couple of dB. Treating flat ground as automatically
    // loss-free is the mistake this asserts against.
    const r = evaluateLink(flatProfile(2000), inputs, budget);
    expect(r.worstClearanceRatio!).toBeLessThan(1);
    expect(r.diffractionLossDb).toBeGreaterThan(0);
  });

  it('lets distance alone break a link, with geometry held constant', () => {
    const near = evaluateLink(flatProfile(2000), inputs, budget);
    const far = evaluateLink(flatProfile(500_000), inputs, budget);

    expect(near.closes).toBe(true);
    expect(far.closes).toBe(false);
    expect(far.freeSpaceLossDb).toBeGreaterThan(near.freeSpaceLossDb);
  });

  it('blocks a path through a hill that a flat path would clear', () => {
    const flat = flatProfile(10_000);
    const hilly = flat.map((s, i) => ({
      ...s,
      // A 300 m ridge in the middle, well above the 10 m/2 m antennas.
      elevation: i > 28 && i < 36 ? 300 : 0,
    }));

    const baseline = evaluateLink(flat, inputs, budget);
    const blocked = evaluateLink(hilly, inputs, budget);

    // Compared against the same path without the ridge, not against zero —
    // flat ground already costs a little (see the Fresnel-intrusion case).
    expect(blocked.diffractionLossDb).toBeGreaterThan(baseline.diffractionLossDb + 6);
    expect(blocked.worstClearanceRatio!).toBeLessThan(0); // LOS itself broken
    expect(baseline.worstClearanceRatio!).toBeGreaterThan(0);
  });

  it('reports partial Fresnel intrusion as loss even with optical line of sight', () => {
    // A ridge just below the straight line still costs signal. Treating "I can
    // see it" as "the link is fine" is the classic planning mistake.
    const samples = flatProfile(10_000).map((s, i) => ({
      ...s,
      elevation: i === 32 ? 4 : 0, // below the ~6 m LOS midpoint, inside the zone
    }));
    const r = evaluateLink(samples, inputs, budget);

    expect(r.worstClearanceRatio!).toBeGreaterThan(0); // LOS not broken
    expect(r.worstClearanceRatio!).toBeLessThan(1);    // but zone intruded
    expect(r.diffractionLossDb).toBeGreaterThan(0);
  });

  it('treats a full first-Fresnel clearance as unobstructed', () => {
    const r = evaluateLink(flatProfile(1000, 0), { ...inputs, txHeightM: 100, rxHeightM: 100 }, budget);
    expect(r.worstClearanceRatio!).toBeGreaterThan(1);
    expect(r.diffractionLossDb).toBe(0);
  });

  it('accounts for earth curvature on long paths', () => {
    // Same flat ground, but curvature alone should cost signal at 60 km.
    const withCurve = evaluateLink(flatProfile(60_000, 0), { ...inputs, txHeightM: 20, rxHeightM: 20 }, budget);
    const noCurve = evaluateLink(
      flatProfile(60_000, 0),
      { ...inputs, txHeightM: 20, rxHeightM: 20, kFactor: 1e9 }, // effectively flat earth
      budget,
    );
    expect(withCurve.diffractionLossDb).toBeGreaterThan(noCurve.diffractionLossDb);
  });

  it('skips DEM gaps instead of reading them as sea level', () => {
    // Reading null as 0 m would invent a canyon under a mountain path and
    // report a clear link. Flagged so the caller can qualify the result.
    const complete = flatProfile(10_000, 500);
    const gapped = complete.map((s, i) => ({ ...s, elevation: i === 32 ? null : s.elevation }));

    const r = evaluateLink(gapped, inputs, budget);
    const baseline = evaluateLink(complete, inputs, budget);

    expect(r.hasDataGaps).toBe(true);
    expect(baseline.hasDataGaps).toBe(false);
    // Identical result: the gap was skipped, not read as a 500 m drop to sea
    // level, which would have shown up as LESS obstruction than the baseline.
    expect(r.diffractionLossDb).toBeCloseTo(baseline.diffractionLossDb, 6);
  });

  it('is symmetric in the link budget — a weaker radio closes fewer links', () => {
    const profile = flatProfile(20_000);
    const strong = evaluateLink(profile, inputs, budget);
    const weak = evaluateLink(profile, inputs, { ...budget, txPowerDbm: 0 });

    expect(strong.marginDb - weak.marginDb).toBeCloseTo(30, 5);
  });

  it('returns a usable result for an empty profile rather than throwing', () => {
    const r = evaluateLink([], inputs, budget);
    expect(r.distanceM).toBe(0);
    expect(Number.isFinite(r.receivedPowerDbm)).toBe(true);
    expect(r.worstClearanceRatio).toBeNull();
  });
});
