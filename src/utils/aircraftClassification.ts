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
  /**
   * Phase 2 (D4): true when the node carried a "confirmed fixed" anchor and
   * the current position is more than `AIRCRAFT_FIXED_RELEASE_M` from it. The
   * caller must clear the mark; the rest of the result is the normal verdict.
   */
  releaseFixed?: boolean;
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

// ---------------------------------------------------------------------------
// Phase 2: age-out and reclassify as fixed (AIRCRAFT_P2_SPEC.md)
// ---------------------------------------------------------------------------

export type AircraftAgeOutAction = 'ignore' | 'delete';
export const AIRCRAFT_AGE_OUT_ACTIONS: readonly AircraftAgeOutAction[] = ['ignore', 'delete'];
export const AIRCRAFT_AGE_OUT_HOURS_DEFAULT = 24;
export const AIRCRAFT_AGE_OUT_HOURS_RANGE = { min: 6, max: 168 } as const;
export const DEFAULT_AIRCRAFT_AGE_OUT_ACTION: AircraftAgeOutAction = 'ignore';

/** A node marked as fixed stays not-aircraft while within this distance of its anchor. */
export const AIRCRAFT_FIXED_RELEASE_M = 1000;
/** Max bounding-box diagonal for a set of fixes to count as stationary. */
export const AIRCRAFT_FIXED_SPAN_M = 200;
/** Minimum number of fixes before the stationary rule can fire. */
export const AIRCRAFT_FIXED_MIN_FIXES = 3;
/** The fixed rule looks at the last 24 h of fixes and needs a node heard in that window. */
export const AIRCRAFT_FIXED_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface AircraftAgeOutSettings {
  enabled: boolean;
  hours: number;
  action: AircraftAgeOutAction;
}

/** Counts from the last sweep, persisted as JSON in `aircraftAgeOutLastResult`. */
export interface AircraftAgeOutLastResult {
  agedOut: number;
  fixed: number;
  lifted: number;
  deleted: number;
}

export function isAircraftAgeOutAction(v: unknown): v is AircraftAgeOutAction {
  return typeof v === 'string' && (AIRCRAFT_AGE_OUT_ACTIONS as readonly string[]).includes(v);
}

/**
 * Parse the raw per-source age-out setting strings. Off unless explicitly
 * `'true'` (D2: off by default); hours clamp into 6–168; any action other
 * than an explicit `'delete'` reads as `'ignore'` (delete is opt-in).
 */
export function parseAircraftAgeOutSettings(raw: {
  enabled?: string | null;
  hours?: string | null;
  action?: string | null;
}): AircraftAgeOutSettings {
  return {
    enabled: raw.enabled === 'true',
    hours: parseThreshold(raw.hours, AIRCRAFT_AGE_OUT_HOURS_DEFAULT, AIRCRAFT_AGE_OUT_HOURS_RANGE),
    action: raw.action === 'delete' ? 'delete' : DEFAULT_AIRCRAFT_AGE_OUT_ACTION,
  };
}

/** Parse the persisted last-result JSON; null on missing or malformed input. */
export function parseAircraftAgeOutLastResult(raw: string | null | undefined): AircraftAgeOutLastResult | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object') return null;
    const num = (x: unknown) => (isFiniteNumber(x) ? x : 0);
    return { agedOut: num(v.agedOut), fixed: num(v.fixed), lifted: num(v.lifted), deleted: num(v.deleted) };
  } catch {
    return null;
  }
}

/** Great-circle distance in metres (haversine). */
export function distanceMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * D4 fixed rule: true when there are at least `AIRCRAFT_FIXED_MIN_FIXES`
 * finite fixes and the diagonal of their bounding box is under
 * `AIRCRAFT_FIXED_SPAN_M`. Non-finite fixes are dropped before counting.
 */
export function isStationaryFix(positions: ReadonlyArray<{ lat: number; lon: number }>): boolean {
  const fixes = positions.filter(p => isFiniteNumber(p.lat) && isFiniteNumber(p.lon));
  if (fixes.length < AIRCRAFT_FIXED_MIN_FIXES) return false;
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of fixes) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  return distanceMeters({ lat: minLat, lon: minLon }, { lat: maxLat, lon: maxLon }) < AIRCRAFT_FIXED_SPAN_M;
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
  /** Phase 2 "confirmed fixed" anchor (D4); null/undefined when not marked. */
  fixedAnchor?: { lat: number; lon: number } | null;
  /** The node's current effective position, compared against `fixedAnchor`. */
  position?: { lat: number; lon: number } | null;
}): AircraftClassification {
  const base = classifyAircraftCore(input);
  const anchor = input.fixedAnchor;
  if (!anchor || !isFiniteNumber(anchor.lat) || !isFiniteNumber(anchor.lon)) return base;
  const pos = input.position;
  const hasPos = !!pos && isFiniteNumber(pos.lat) && isFiniteNumber(pos.lon);
  // No usable position: we cannot tell it moved, so the mark holds.
  if (!hasPos || distanceMeters(anchor, pos!) <= AIRCRAFT_FIXED_RELEASE_M) {
    return { ...base, likelyAircraft: base.likelyAircraft === null ? null : false };
  }
  return { ...base, releaseFixed: true };
}

function classifyAircraftCore(input: {
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
