/**
 * Pure scalar radio-link math for the Terrain Link Profile tool
 * (Terrain Link Profile epic #4111, Phase 2, WP-A). React/leaflet-free so it
 * is trivially unit-testable and reusable outside the map UI, mirroring the
 * style of `src/utils/measureDistance.ts` and `src/utils/greatCircle.ts`.
 *
 * Sign conventions (see LINK_PROFILE_TOOL_SPEC.md §0 for the locked reference
 * values these formulas must reproduce):
 *   - FSPL is a loss, expressed as a positive dB value that is *subtracted*
 *     from the transmitted signal to get received power.
 *   - Antenna/cable gains and losses: TX power, TX gain, and RX gain add;
 *     cable loss and FSPL subtract.
 *   - `rxSensitivityDbm` is conventionally negative (e.g. -129 dBm). Margin
 *     is `rxPowerDbm - rxSensitivityDbm`, so a more negative (better)
 *     sensitivity increases the margin. Positive margin means the link
 *     closes.
 */

/** Speed of light, metres per second. */
export const SPEED_OF_LIGHT_MPS = 299_792_458;

/** Mean Earth radius, metres. */
export const EARTH_RADIUS_M = 6_371_000;

/** Standard "4/3 Earth" refraction k-factor used for radio LOS planning. */
export const DEFAULT_K_FACTOR = 4 / 3;

/**
 * Wavelength in metres for a frequency given in MHz.
 * `λ = c / f`, with f converted from MHz to Hz.
 */
export function wavelengthMeters(freqMhz: number): number {
  return SPEED_OF_LIGHT_MPS / (freqMhz * 1_000_000);
}

/**
 * nth Fresnel-zone radius (metres) at a point `d1` metres from one endpoint
 * and `d2` metres from the other (`d1 + d2` = total path length).
 *
 * `r_n = sqrt(n * λ * d1 * d2 / (d1 + d2))`.
 *
 * Returns 0 at the endpoints themselves (`d1 === 0` or `d2 === 0`), where the
 * Fresnel zone radius is mathematically zero, and also guards the
 * `d1 + d2 === 0` degenerate case (coincident points) to avoid a NaN from
 * division by zero.
 */
export function fresnelRadiusMeters(n: number, freqMhz: number, d1M: number, d2M: number): number {
  if (d1M <= 0 || d2M <= 0) return 0;
  const total = d1M + d2M;
  if (total <= 0) return 0;
  const lambda = wavelengthMeters(freqMhz);
  return Math.sqrt((n * lambda * d1M * d2M) / total);
}

/**
 * Free-space path loss in dB for a link of `distanceKm` at `freqMhz`.
 * `FSPL(dB) = 20*log10(d_km) + 20*log10(f_MHz) + 32.44`.
 *
 * The classic FSPL formula is undefined (log of 0/negative) at zero or
 * negative distance; callers pass distanceKm === 0 only for a degenerate
 * (coincident-point) link, so this returns 0 dB loss in that case rather
 * than -Infinity/NaN. Negative distances are treated as their absolute
 * value's mirror is not meaningful either — also clamped to 0 dB.
 */
export function fsplDb(distanceKm: number, freqMhz: number): number {
  if (distanceKm <= 0 || freqMhz <= 0) return 0;
  return 20 * Math.log10(distanceKm) + 20 * Math.log10(freqMhz) + 32.44;
}

/**
 * Earth-curvature bulge (metres) at a point `d1` metres from one endpoint and
 * `d2` metres from the other, for refraction factor `kFactor` (default 4/3)
 * and Earth radius `earthRadiusM` (default mean Earth radius).
 *
 * `bulge = d1 * d2 / (2 * k * R)`. Zero at either endpoint (`d1 === 0` or
 * `d2 === 0`), consistent with the geometric definition (no rise directly
 * under either antenna).
 */
export function earthBulgeMeters(
  d1M: number,
  d2M: number,
  kFactor: number = DEFAULT_K_FACTOR,
  earthRadiusM: number = EARTH_RADIUS_M,
): number {
  if (d1M <= 0 || d2M <= 0 || kFactor <= 0 || earthRadiusM <= 0) return 0;
  return (d1M * d2M) / (2 * kFactor * earthRadiusM);
}

/** Inputs to a full link-budget calculation, independent of path geometry. */
export interface LinkBudgetInputs {
  txPowerDbm: number;
  txGainDbi: number;
  rxGainDbi: number;
  /** Total cable/connector loss across both ends, dB (positive). */
  cableLossDb: number;
  /** Receiver sensitivity, dBm (conventionally negative). */
  rxSensitivityDbm: number;
}

/** Computed link-budget outputs. */
export interface LinkBudgetResult {
  fsplDb: number;
  /** txPower + txGain + rxGain - cableLoss - FSPL. */
  rxPowerDbm: number;
  /** rxPower - rxSensitivity. Positive means the link closes. */
  marginDb: number;
}

/**
 * Combine free-space path loss (derived from `distanceKm`/`freqMhz`) with the
 * budget inputs to get received power and link margin. See module-level
 * doc comment for the sign conventions.
 */
export function computeLinkBudget(
  distanceKm: number,
  freqMhz: number,
  inputs: LinkBudgetInputs,
): LinkBudgetResult {
  const loss = fsplDb(distanceKm, freqMhz);
  const rxPowerDbm =
    inputs.txPowerDbm + inputs.txGainDbi + inputs.rxGainDbi - inputs.cableLossDb - loss;
  const marginDb = rxPowerDbm - inputs.rxSensitivityDbm;
  return { fsplDb: loss, rxPowerDbm, marginDb };
}
