/**
 * Pure likely-aircraft classification logic (#5364/#5365 Phase 1 WP1, spec
 * §4.1).
 *
 * Shared by server (the classification queue, settings validation) and
 * client (the settings form's ranges, the popup summary line). It must not
 * import the DB, Leaflet or React — everything here is math and string
 * formatting over plain inputs. Uses `.js` relative imports since it is in
 * the server compile set (tsconfig.server.json).
 */
import type { TFunction } from 'i18next';

export type AircraftBasis = 'agl' | 'msl' | 'unknown';
export type AircraftDisplayMode = 'show' | 'mark' | 'hide';

export const DEFAULT_AIRCRAFT_AGL_THRESHOLD_M = 500;
export const DEFAULT_AIRCRAFT_MSL_THRESHOLD_M = 5000;
export const AIRCRAFT_AGL_RANGE = { min: 50, max: 20000 } as const;
export const AIRCRAFT_MSL_RANGE = { min: 500, max: 20000 } as const;
export const AIRCRAFT_DISPLAY_MODES: readonly AircraftDisplayMode[] = ['show', 'mark', 'hide'];
export const DEFAULT_AIRCRAFT_DISPLAY_MODE: AircraftDisplayMode = 'mark';

export interface AircraftSettings {
  enabled: boolean;
  aglThresholdM: number;
  mslThresholdM: number;
}

export interface AircraftPrevious {
  likelyAircraft: boolean | null;
  basis: AircraftBasis | null;
}

export interface AircraftClassification {
  likelyAircraft: boolean | null;
  basis: AircraftBasis;
  /** Passthrough of the input (null if not finite). */
  groundElevation: number | null;
  /** Signed; only set when basis === 'agl'. */
  heightAboveGround: number | null;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Parse a threshold string into a valid integer within `range`. Null,
 * undefined, or non-numeric input falls back to `fallback`. A finite but
 * out-of-range number is clamped into range (never rejected).
 */
function parseThreshold(
  raw: string | null | undefined,
  fallback: number,
  range: { min: number; max: number },
): number {
  if (raw === null || raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return clamp(Math.round(n), range.min, range.max);
}

/**
 * Parse the three raw per-source setting strings into a validated
 * `AircraftSettings`. Garbage / missing input falls back to the defaults;
 * out-of-range numbers are clamped rather than rejected (D6: settings
 * validation at the route layer rejects out-of-range POSTs outright — this
 * function is the tolerant read-side counterpart used by the classifier).
 */
export function parseAircraftSettings(raw: {
  enabled?: string | null;
  aglThresholdM?: string | null;
  mslThresholdM?: string | null;
}): AircraftSettings {
  return {
    enabled: raw.enabled !== 'false',
    aglThresholdM: parseThreshold(raw.aglThresholdM, DEFAULT_AIRCRAFT_AGL_THRESHOLD_M, AIRCRAFT_AGL_RANGE),
    mslThresholdM: parseThreshold(raw.mslThresholdM, DEFAULT_AIRCRAFT_MSL_THRESHOLD_M, AIRCRAFT_MSL_RANGE),
  };
}

/** max(50, round(0.1 × threshold)) — D8. */
export function aircraftHysteresisM(thresholdM: number): number {
  return Math.max(50, Math.round(thresholdM * 0.1));
}

/**
 * Classify a single altitude reading against ground elevation (when known)
 * or the MSL fallback threshold, with hysteresis (D8) once a node is already
 * flagged on the same basis.
 *
 * Does NOT look at `settings.enabled` — the caller (the classification
 * service) handles disable, keeping this function total and easy to test.
 */
export function classifyAircraft(input: {
  altitudeM: number | null | undefined;
  groundElevationM: number | null | undefined;
  settings: AircraftSettings;
  previous?: AircraftPrevious | null;
}): AircraftClassification {
  const { altitudeM, groundElevationM, settings, previous } = input;
  const ground = isFiniteNumber(groundElevationM) ? groundElevationM : null;

  if (!isFiniteNumber(altitudeM)) {
    return { likelyAircraft: null, basis: 'unknown', groundElevation: ground, heightAboveGround: null };
  }

  if (isFiniteNumber(groundElevationM)) {
    const hag = altitudeM - groundElevationM;
    const threshold = settings.aglThresholdM;
    const wasFlaggedAgl = previous?.likelyAircraft === true && previous.basis === 'agl';
    const flagged = wasFlaggedAgl
      ? hag > threshold - aircraftHysteresisM(threshold)
      : hag > threshold;
    return { likelyAircraft: flagged, basis: 'agl', groundElevation: ground, heightAboveGround: hag };
  }

  const threshold = settings.mslThresholdM;
  const wasFlaggedMsl = previous?.likelyAircraft === true && previous.basis === 'msl';
  const flagged = wasFlaggedMsl
    ? altitudeM > threshold - aircraftHysteresisM(threshold)
    : altitudeM > threshold;
  return { likelyAircraft: flagged, basis: 'msl', groundElevation: ground, heightAboveGround: null };
}

/** True only for a transition INTO the flagged state: prev !== true && next === true. */
export function isAircraftTransition(prev: boolean | null | undefined, next: boolean | null): boolean {
  return prev !== true && next === true;
}

/** Coerce SQLite 0/1, PG/MySQL booleans, null/undefined → boolean | null. */
export function normalizeLikelyAircraft(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    if (v === '1' || v.toLowerCase() === 'true') return true;
    if (v === '0' || v.toLowerCase() === 'false') return false;
  }
  return null;
}

export function isAircraftDisplayMode(v: unknown): v is AircraftDisplayMode {
  return typeof v === 'string' && (AIRCRAFT_DISPLAY_MODES as readonly string[]).includes(v);
}

/** "850 m" below 1000 m, "1.2 km" at or above (one decimal). */
function formatHeightMeters(m: number): string {
  const abs = Math.abs(m);
  if (abs >= 1000) {
    return `${(m / 1000).toFixed(1)} km`;
  }
  return `${Math.round(m)} m`;
}

/**
 * Popup/details summary line for a flagged node, e.g.
 * "Likely aircraft · 1.2 km above ground" (AGL) or
 * "Likely aircraft · 6.1 km above sea level" (MSL fallback).
 */
export function formatAircraftSummary(
  m: { aircraftBasis?: string | null; heightAboveGround?: number | null; altitude?: number | null },
  t: TFunction,
): string {
  if (m.aircraftBasis === 'agl' && isFiniteNumber(m.heightAboveGround)) {
    const height = formatHeightMeters(m.heightAboveGround);
    return t('node_popup.aircraft_agl', 'Likely aircraft · {{height}} above ground', { height });
  }
  // No usable height (e.g. the altitude was cleared after classification):
  // say only "Likely aircraft" rather than print a made-up "0 m".
  if (!isFiniteNumber(m.altitude)) {
    return t('node_popup.aircraft', 'Likely aircraft');
  }
  const height = formatHeightMeters(m.altitude);
  return t('node_popup.aircraft_msl', 'Likely aircraft · {{height}} above sea level', { height });
}
