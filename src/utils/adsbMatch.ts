/**
 * Pure ADS-B matcher for likely-aircraft nodes (#5374, ADSB_MATCH_SPEC.md
 * "Matching"). Given a node's fix and a feed's aircraft list, pick the one
 * aircraft that is plausibly the node, or null.
 *
 * No I/O here: the service fetches, this decides.
 */
import { calculateDistance } from './distance.js';

/** One aircraft as the ADSBx v2 / readsb JSON reports it (only the fields we read). */
export interface AdsbAircraft {
  hex?: string;
  flight?: string;
  /** ICAO type designator, e.g. "B738". */
  t?: string;
  /** Registration, e.g. "N12345". */
  r?: string;
  lat?: number;
  lon?: number;
  /** Feet, or the string "ground". */
  alt_baro?: number | string;
  /** Feet. */
  alt_geom?: number;
  /** Knots. */
  gs?: number;
  /** Degrees true. */
  track?: number;
  /** Seconds since the position was received. */
  seen_pos?: number;
}

export interface AdsbMatch {
  hex: string;
  callsign: string | null;
  type: string | null;
  registration: string | null;
  gsKt: number | null;
  trackDeg: number | null;
  altM: number | null;
  distanceKm: number;
}

export interface AdsbMatchInput {
  latitude: number;
  longitude: number;
  /** Node altitude, metres MSL. */
  altitudeM: number;
  /** Observation time of the node's fix, epoch ms. */
  positionTimestampMs: number | null | undefined;
  /** Now, epoch ms. */
  nowMs: number;
}

export const FT_TO_M = 0.3048;
export const KM_PER_NM = 1.852;
/** Radius floor and ceiling, km. */
export const MIN_RADIUS_KM = 5;
export const MAX_RADIUS_KM = 90;
/** ~250 kt, the distance an airliner can cover per second of fix age. */
export const RADIUS_KM_PER_SEC = 0.13;
/** Max node-vs-aircraft altitude gap, metres. */
export const ALT_WINDOW_M = 300;
/** A second candidate within this factor of the nearest makes the pick ambiguous. */
export const AMBIGUITY_FACTOR = 1.25;

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** `clamp(5 + ageSec × 0.13, 5, 90)` km. An unknown or future timestamp counts as age 0. */
export function searchRadiusKm(positionTimestampMs: number | null | undefined, nowMs: number): number {
  const ageSec = finite(positionTimestampMs) ? Math.max(0, (nowMs - positionTimestampMs) / 1000) : 0;
  return Math.min(MAX_RADIUS_KM, Math.max(MIN_RADIUS_KM, MIN_RADIUS_KM + ageSec * RADIUS_KM_PER_SEC));
}

/** Query distance for the feed, whole nautical miles. */
export function radiusToNm(radiusKm: number): number {
  return Math.ceil(radiusKm / KM_PER_NM);
}

/** Aircraft altitude in metres: `alt_geom`, else numeric `alt_baro`, else null. */
export function aircraftAltitudeM(ac: AdsbAircraft): number | null {
  if (finite(ac.alt_geom)) return ac.alt_geom * FT_TO_M;
  if (finite(ac.alt_baro)) return ac.alt_baro * FT_TO_M;
  return null;
}

function cleanText(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length > 0 ? s : null;
}

/**
 * The nearest airborne aircraft within the radius and the altitude window, or
 * null when there is none or when a second candidate is too close to call.
 */
export function matchAircraft(input: AdsbMatchInput, aircraft: readonly AdsbAircraft[]): AdsbMatch | null {
  if (!finite(input.latitude) || !finite(input.longitude) || !finite(input.altitudeM)) return null;
  const radiusKm = searchRadiusKm(input.positionTimestampMs, input.nowMs);

  const candidates: Array<{ ac: AdsbAircraft; hex: string; distanceKm: number; altM: number }> = [];
  for (const ac of aircraft) {
    if (!ac || typeof ac !== 'object') continue;
    const hex = cleanText(ac.hex);
    if (!hex) continue;
    if (!finite(ac.lat) || !finite(ac.lon)) continue;
    if (ac.alt_baro === 'ground') continue;
    const altM = aircraftAltitudeM(ac);
    if (altM === null) continue;
    if (Math.abs(input.altitudeM - altM) > ALT_WINDOW_M) continue;
    const distanceKm = calculateDistance(input.latitude, input.longitude, ac.lat, ac.lon);
    if (distanceKm > radiusKm) continue;
    candidates.push({ ac, hex: hex.toLowerCase(), distanceKm, altM });
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => a.distanceKm - b.distanceKm);
  const [best, second] = candidates;
  if (second && second.distanceKm <= best.distanceKm * AMBIGUITY_FACTOR) return null;

  return {
    hex: best.hex,
    callsign: cleanText(best.ac.flight),
    type: cleanText(best.ac.t),
    registration: cleanText(best.ac.r),
    gsKt: finite(best.ac.gs) ? best.ac.gs : null,
    trackDeg: finite(best.ac.track) ? best.ac.track : null,
    altM: best.altM,
    distanceKm: best.distanceKm,
  };
}
