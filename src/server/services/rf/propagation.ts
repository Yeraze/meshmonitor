/**
 * RF propagation model (#4727) — Fresnel clearance + path loss.
 *
 * Pure functions over a terrain profile. No IO, no database, no elevation
 * fetching: the caller supplies samples (from `elevationService.computeProfile`)
 * and this decides whether a link closes.
 *
 * **This is a MODEL, and a deliberately simple one.** It accounts for
 * free-space spreading, earth curvature, and single-knife-edge diffraction over
 * the dominant obstruction. It does NOT model multipath, ground reflection,
 * foliage, buildings, atmospheric absorption, polarisation, or antenna
 * patterns beyond a scalar gain. Real-world range routinely differs from this
 * by tens of dB in both directions. Everything downstream must present output
 * as a prediction with stated assumptions, never as measured coverage — the
 * issue (#4727) is explicit that an unqualified prediction gets read as ground
 * truth.
 *
 * Chosen over Longley-Rice deliberately: ITM is more accurate over irregular
 * terrain but means a sizeable port or a new dependency, and a model whose
 * assumptions a reader can follow is worth more here than one whose output
 * merely looks authoritative.
 *
 * Units are SI internally (metres, hertz, watts-as-dBm). The textbook
 * km/GHz forms are used only in tests, as an independent check on the
 * SI implementations.
 */

import { EARTH_RADIUS_M } from '../../../utils/earthConstants.js';

/** Speed of light, m/s. */
const C = 299_792_458;

/**
 * Effective-earth-radius factor for standard atmospheric refraction. 4/3 is
 * the long-standing default for terrestrial VHF/UHF planning: the atmosphere
 * bends signals slightly downward, so the radio horizon sits beyond the
 * geometric one. Exposed so a caller can model non-standard conditions.
 */
export const DEFAULT_K_FACTOR = 4 / 3;

export interface TerrainSample {
  /** Metres from the transmitter along the path. */
  distance: number;
  /** Ground elevation in metres, or null where the DEM had no data. */
  elevation: number | null;
}

export interface LinkBudget {
  /** Transmit power at the connector, dBm. */
  txPowerDbm: number;
  /** Antenna gains, dBi. */
  txGainDbi: number;
  rxGainDbi: number;
  /** Feedline/connector losses, dB. Positive numbers are losses. */
  lossesDb: number;
  /** Receiver sensitivity, dBm — the link closes at or above this. */
  sensitivityDbm: number;
}

export interface LinkInputs {
  frequencyHz: number;
  /** Antenna heights ABOVE GROUND, metres. */
  txHeightM: number;
  rxHeightM: number;
  kFactor?: number;
}

export interface LinkResult {
  /** True when received power meets or exceeds sensitivity. */
  closes: boolean;
  distanceM: number;
  freeSpaceLossDb: number;
  /** Knife-edge diffraction loss over the worst obstruction, dB (>= 0). */
  diffractionLossDb: number;
  receivedPowerDbm: number;
  /** Margin above sensitivity, dB. Negative means the link fails. */
  marginDb: number;
  /**
   * Worst first-Fresnel clearance along the path, as a fraction of the first
   * Fresnel radius. >= 1 is full clearance; 0 means the obstruction just
   * touches the optical line of sight; negative means the LOS itself is blocked.
   * Null when terrain data was missing for the whole path.
   */
  worstClearanceRatio: number | null;
  /** True when any sample lacked elevation data — the result is less trustworthy. */
  hasDataGaps: boolean;
}

export function wavelengthM(frequencyHz: number): number {
  return C / frequencyHz;
}

/**
 * First Fresnel zone radius at a point, metres.
 *
 * `sqrt(lambda * d1 * d2 / D)` in SI. The familiar
 * `17.31 * sqrt(d1*d2/(f*D))` (km, GHz) is the same expression with the
 * constants folded in; the test suite checks the two agree.
 */
export function fresnelRadiusM(
  wavelength: number,
  d1: number,
  d2: number,
  total: number,
): number {
  if (total <= 0 || d1 < 0 || d2 < 0) return 0;
  return Math.sqrt((wavelength * d1 * d2) / total);
}

/**
 * Apparent height added by earth curvature at a point, metres.
 *
 * Terrain "bulges" upward between the endpoints relative to the straight line
 * joining them. Ignoring this makes long paths look far better than they are —
 * at 30 km it is already ~13 m of unmodelled obstruction.
 */
export function earthBulgeM(d1: number, d2: number, kFactor: number = DEFAULT_K_FACTOR): number {
  if (d1 <= 0 || d2 <= 0) return 0;
  return (d1 * d2) / (2 * kFactor * EARTH_RADIUS_M);
}

/**
 * Free-space path loss, dB. `20log10(4*pi*d/lambda)`.
 *
 * Returns 0 below one wavelength rather than the negative value the formula
 * yields there — "gain" from being close is not a thing this model should
 * report, and callers compare against sensitivity.
 */
export function freeSpaceLossDb(distanceM: number, wavelength: number): number {
  if (distanceM <= 0 || wavelength <= 0) return 0;
  const loss = 20 * Math.log10((4 * Math.PI * distanceM) / wavelength);
  return Math.max(0, loss);
}

/**
 * Single knife-edge diffraction loss, dB, from the ITU-R P.526 approximation
 * to the Fresnel-Kirchhoff parameter `v`.
 *
 * `J(v) = 6.9 + 20*log10( sqrt((v-0.1)^2 + 1) + v - 0.1 )` for `v > -0.7`,
 * and zero below that (the obstruction is far enough out of the way to be
 * negligible). Note that even a clear path incurs a little loss as `v`
 * approaches -0.7 from below, which is why grazing paths are not free.
 */
export function knifeEdgeLossDb(v: number): number {
  if (!Number.isFinite(v) || v <= -0.7) return 0;
  return 6.9 + 20 * Math.log10(Math.sqrt((v - 0.1) ** 2 + 1) + v - 0.1);
}

/**
 * Spherical (smooth) earth diffraction loss, dB — ITU-R P.526-14 §3.1.1, the
 * F(X) + G(Y) residue-series method (#4727 follow-up).
 *
 * **Why this exists.** Single knife-edge diffraction badly UNDER-models the
 * earth's OWN curvature: it treats a smooth ~8,500 km-radius bulge as a sharp
 * edge and charges only ~12 dB at 50 km where the true over-horizon loss is
 * ~58 dB. Without it a low antenna over flat ground or water "reaches" 100 km+,
 * ignoring the radio horizon entirely — the reported #4727 symptom over flat
 * South Florida. `evaluateLink` takes the WORSE of this and the terrain
 * knife-edge, so a real ridge still dominates where it should while the smooth
 * earth is no longer free.
 *
 * **β = 1** for horizontal polarisation at any frequency, and vertical above
 * 20 MHz over land / 300 MHz over sea (P.526 Eq. 16) — true for every LoRa
 * band, so it is fixed. The surface-admittance K (~5e-4 at UHF) makes the
 * height-gain floor `2 + 20·log10(K)` non-binding, so it is omitted.
 *
 * **Horizon gate.** Below the line-of-sight horizon (P.526 Eq. 21) the ray
 * clears the bulge, so this returns 0. The §3.2 sub-horizon interpolation is
 * deliberately not implemented: those paths are limited by free-space loss, and
 * a coverage sweep's reach (first failure) always lands beyond the horizon, so
 * the small step at the horizon is never the deciding sample.
 *
 * `txHeightM` / `rxHeightM` are heights above the smooth-earth datum (≈ mean
 * sea level) — ground elevation PLUS antenna height, not the bare antenna
 * height — so an endpoint on high terrain gets its correspondingly far horizon.
 * Over flat ground at sea level they equal the antenna heights.
 *
 * Returns positive dB (>= 0). `distanceM` is the great-circle path length; the
 * practical-unit constants (2.188, 9.575e-3) take d in km, f in MHz, a_e in km,
 * h in m.
 */
export function sphericalEarthDiffractionLossDb(
  distanceM: number,
  frequencyHz: number,
  txHeightM: number,
  rxHeightM: number,
  kFactor: number = DEFAULT_K_FACTOR,
): number {
  if (distanceM <= 0 || frequencyHz <= 0) return 0;
  // Floor the effective heights at a small positive value. A literal 0 m makes
  // the height-gain G(Y) diverge (Y=0 -> log(0) -> -Infinity -> Infinity loss),
  // and a device sitting on the ground still has its antenna a few decimetres
  // up. Flooring (rather than bailing to 0 loss) keeps the curvature limit
  // active for ground-level receivers, which is the whole point of this term.
  const MIN_EFFECTIVE_HEIGHT_M = 0.5;
  const h1 = Math.max(txHeightM, MIN_EFFECTIVE_HEIGHT_M);
  const h2 = Math.max(rxHeightM, MIN_EFFECTIVE_HEIGHT_M);

  // Radio (LOS) horizon over the effective earth, P.526 Eq. 21 in SI metres:
  // d_los = sqrt(2·a_e)·(sqrt(h1)+sqrt(h2)). Reduces to 4.12·(√h1+√h2) km for
  // k=4/3. Below it, the direct ray clears the bulge → no curvature loss.
  const dLosM = Math.sqrt(2 * kFactor * EARTH_RADIUS_M) * (Math.sqrt(h1) + Math.sqrt(h2));
  if (distanceM <= dLosM) return 0;

  const aeKm = (kFactor * EARTH_RADIUS_M) / 1000;
  const fMHz = frequencyHz / 1e6;
  const dKm = distanceM / 1000;

  // X — normalized path length (Eq. 14a). Y — normalized height (Eq. 15a).
  const X = 2.188 * Math.cbrt(fMHz) * Math.pow(aeKm, -2 / 3) * dKm;
  const yOf = (h: number) => 9.575e-3 * Math.pow(fMHz, 2 / 3) * Math.pow(aeKm, -1 / 3) * h;

  // F(X) — distance term (Eqs. 17a / 17b).
  const F = X >= 1.6
    ? 11 + 10 * Math.log10(X) - 17.6 * X
    : -20 * Math.log10(X) - 5.6488 * Math.pow(X, 1.425);

  // G(Y) — height-gain term (Eqs. 18 / 18a), β = 1 so B = Y.
  const gainG = (h: number): number => {
    const Y = yOf(h);
    if (Y > 2) return 17.6 * Math.sqrt(Y - 1.1) - 5 * Math.log10(Y - 1.1) - 8;
    const arg = Y + 0.1 * Y ** 3; // can be <= 0 for a zero-height antenna
    return arg > 0 ? 20 * Math.log10(arg) : -Infinity;
  };

  // Eq. 13 gives the field relative to free space (dB, negative in shadow);
  // attenuation is its negation (P.526-14 §3.1.2 Note 1). Clamp to >= 0: a
  // positive bracket would mean "above free space", where the method is invalid.
  const eDb = F + gainG(h1) + gainG(h2);
  return Math.max(0, -eDb);
}

/**
 * Evaluate one point-to-point link over a terrain profile.
 *
 * `samples` must run from the transmitter (distance 0) to the receiver, with
 * `distance` in metres. The first and last samples supply ground elevation at
 * each end; antenna heights are added to those.
 *
 * Samples with null elevation are skipped rather than treated as sea level —
 * a DEM gap is missing information, and reading it as 0 m would invent a
 * canyon and fail links that are fine. `hasDataGaps` reports that this
 * happened so the caller can qualify the result.
 */
export function evaluateLink(
  samples: TerrainSample[],
  inputs: LinkInputs,
  budget: LinkBudget,
): LinkResult {
  const wavelength = wavelengthM(inputs.frequencyHz);
  const kFactor = inputs.kFactor ?? DEFAULT_K_FACTOR;
  const total = samples.length ? samples[samples.length - 1].distance : 0;

  const txGround = samples[0]?.elevation ?? 0;
  const rxGround = samples[samples.length - 1]?.elevation ?? 0;
  const txAlt = txGround + inputs.txHeightM;
  const rxAlt = rxGround + inputs.rxHeightM;

  let hasDataGaps = samples.some((s) => s.elevation == null);
  let worstClearanceRatio: number | null = null;
  let worstV = -Infinity;

  // Interior samples only: the endpoints are the antennas themselves.
  for (let i = 1; i < samples.length - 1; i++) {
    const s = samples[i];
    if (s.elevation == null) { hasDataGaps = true; continue; }

    const d1 = s.distance;
    const d2 = total - d1;
    if (d1 <= 0 || d2 <= 0) continue;

    // Straight line between antennas at this distance, plus the earth's bulge
    // pushing terrain up toward it.
    const losAlt = txAlt + ((rxAlt - txAlt) * d1) / total;
    const obstructionAlt = s.elevation + earthBulgeM(d1, d2, kFactor);

    // Height of the obstruction above the line of sight. Positive = blocking.
    const h = obstructionAlt - losAlt;
    const r1 = fresnelRadiusM(wavelength, d1, d2, total);

    // Clearance as a fraction of the first Fresnel radius. A degenerate r1
    // (co-located points) would divide by zero, so treat it as fully blocked
    // when the obstruction is above the LOS and clear otherwise.
    const clearanceRatio = r1 > 0 ? -h / r1 : (h > 0 ? -Infinity : Infinity);
    if (worstClearanceRatio === null || clearanceRatio < worstClearanceRatio) {
      worstClearanceRatio = clearanceRatio;
    }

    // Fresnel-Kirchhoff v. Equivalent to h * sqrt(2D / (lambda*d1*d2)), which
    // is exactly sqrt(2) * h / r1 — computed from r1 to keep the two
    // quantities consistent with each other.
    const v = r1 > 0 ? (h * Math.SQRT2) / r1 : (h > 0 ? Infinity : -Infinity);
    if (v > worstV) worstV = v;
  }

  // Diffraction is the WORSE of two mechanisms, never their sum: a sharp terrain
  // ridge (single knife-edge over the worst interior sample) and the smooth
  // earth's own curvature (ITU-R P.526 spherical earth). Max, not sum, so the
  // two curvature models — the knife-edge's earth-bulge term and the spherical
  // term — are not double-counted; whichever obstructs more wins (#4727).
  const knifeEdge = Number.isFinite(worstV) ? knifeEdgeLossDb(worstV) : 0;
  // Spherical-earth heights are measured above the smooth-earth datum (≈ MSL),
  // i.e. ground elevation + antenna height — NOT the bare antenna height. An
  // endpoint on a 1500 m peak has a far horizon and little curvature loss, which
  // is what keeps a mountaintop-repeater link reachable.
  const spherical = sphericalEarthDiffractionLossDb(
    total, inputs.frequencyHz, txAlt, rxAlt, kFactor,
  );
  const diffractionLossDb = Math.max(knifeEdge, spherical);
  const fspl = freeSpaceLossDb(total, wavelength);

  const receivedPowerDbm =
    budget.txPowerDbm + budget.txGainDbi + budget.rxGainDbi
    - budget.lossesDb - fspl - diffractionLossDb;

  const marginDb = receivedPowerDbm - budget.sensitivityDbm;

  return {
    closes: marginDb >= 0,
    distanceM: total,
    freeSpaceLossDb: fspl,
    diffractionLossDb,
    receivedPowerDbm,
    marginDb,
    worstClearanceRatio,
    hasDataGaps,
  };
}
