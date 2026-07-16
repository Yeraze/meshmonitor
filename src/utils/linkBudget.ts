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

/**
 * Demodulator SNR floor (dB) per LoRa spreading factor, from the Semtech
 * SX1262 datasheet's sensitivity table (#4111 P3 WP-1).
 */
export const LORA_SNR_LIMIT_DB: Record<number, number> = {
  7: -7.5,
  8: -10,
  9: -12.5,
  10: -15,
  11: -17.5,
  12: -20,
};

/** SX1262 receiver noise figure (dB), used as the default in `loRaSensitivityDbm`. */
export const DEFAULT_NOISE_FIGURE_DB = 6;

/**
 * LoRa receiver sensitivity (dBm): `S = -174 + 10*log10(BW_Hz) + NF + SNR_min(SF)`.
 * The standard thermal-noise link-budget formula (-174 dBm/Hz is the thermal
 * noise floor at room temperature) — computed rather than a transcribed
 * magic table, so it's derived and unit-testable (#4111 P3 WP-1, spec §0.2).
 *
 * Returns `null` for an unknown spreading factor or non-positive bandwidth.
 */
export function loRaSensitivityDbm(
  spreadingFactor: number,
  bandwidthKhz: number,
  noiseFigureDb: number = DEFAULT_NOISE_FIGURE_DB,
): number | null {
  const snrMinDb = LORA_SNR_LIMIT_DB[spreadingFactor];
  if (snrMinDb === undefined || bandwidthKhz <= 0) return null;
  return -174 + 10 * Math.log10(bandwidthKhz * 1000) + noiseFigureDb + snrMinDb;
}

/**
 * Meshtastic modem-preset enum → (SF, BW kHz). Mirrors the `params` strings in
 * `src/components/configuration/constants.ts` `MODEM_PRESET_OPTIONS` (BW) plus
 * the firmware's `modemPresetToParams` switch (SF) — see that file for the
 * per-preset descriptions. Preset `2` (`VERY_LONG_SLOW`) is intentionally
 * omitted: it is deprecated/removed from `MODEM_PRESET_OPTIONS` and is not a
 * selectable preset in the UI, so `rxSensitivityForModemPreset(2)` returns
 * `null` like any other unknown value.
 */
export const MODEM_PRESET_PARAMS: Record<number, { sf: number; bwKhz: number }> = {
  0: { sf: 11, bwKhz: 250 },  // LONG_FAST
  1: { sf: 12, bwKhz: 125 },  // LONG_SLOW
  3: { sf: 10, bwKhz: 250 },  // MEDIUM_SLOW
  4: { sf: 9, bwKhz: 250 },   // MEDIUM_FAST
  5: { sf: 8, bwKhz: 250 },   // SHORT_SLOW
  6: { sf: 7, bwKhz: 250 },   // SHORT_FAST
  7: { sf: 11, bwKhz: 125 },  // LONG_MODERATE
  8: { sf: 7, bwKhz: 500 },   // SHORT_TURBO
  9: { sf: 11, bwKhz: 500 },  // LONG_TURBO
  10: { sf: 9, bwKhz: 125 },  // LITE_FAST
  11: { sf: 10, bwKhz: 125 }, // LITE_SLOW
  12: { sf: 7, bwKhz: 62.5 }, // NARROW_FAST
  13: { sf: 8, bwKhz: 62.5 }, // NARROW_SLOW
};

/** RX sensitivity (dBm) for a Meshtastic modem preset, or `null` if unknown. */
export function rxSensitivityForModemPreset(
  modemPreset: number,
  noiseFigureDb: number = DEFAULT_NOISE_FIGURE_DB,
): number | null {
  const params = MODEM_PRESET_PARAMS[modemPreset];
  return params ? loRaSensitivityDbm(params.sf, params.bwKhz, noiseFigureDb) : null;
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
