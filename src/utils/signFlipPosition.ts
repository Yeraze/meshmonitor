/**
 * Sign-flipped position detection (#5363).
 *
 * Meshtastic nodes accept hand-entered coordinates, and operators in the
 * western or southern hemisphere sometimes type them without the minus sign.
 * The node then lands on the wrong side of the globe. When the feature is on,
 * a position that is far from a reference point but whose mirror image sits
 * close to it is treated as a data-entry mistake and shown at the mirror point.
 *
 * Display only: callers must keep the stored coordinates unchanged and expose
 * the reported ones next to the corrected pair.
 *
 * Shared by server and client, so no DB, React or Leaflet imports. Relative
 * imports carry `.js` because this file is in the server compile set.
 */
import { calculateDistance } from './distance.js';
import { isBogusPosition, isValidLatLng } from './nullIsland.js';

/** Default detection range, in km (~310 mi). */
export const SIGN_FLIP_DEFAULT_RANGE_KM = 500;
/**
 * Accepted range, in km. The upper bound stays well under a hemisphere on
 * purpose: the wider the circle, the more likely a genuine far-away node
 * (for example one heard over MQTT) has a mirror point that lands inside it
 * and gets moved by mistake.
 */
export const SIGN_FLIP_RANGE_KM = { min: 10, max: 2000 } as const;

/** Which sign(s) the correction negated. */
export type SignFlipVariant = 'latitude' | 'longitude' | 'both';

export interface LatLon {
  latitude: number;
  longitude: number;
}

export interface SignFlipSettings {
  enabled: boolean;
  rangeKm: number;
  /** Manual reference point; null means "use the source's own node". */
  manualReference: LatLon | null;
}

export interface SignFlipCorrection extends LatLon {
  variant: SignFlipVariant;
}

const VARIANTS: ReadonlyArray<{ variant: SignFlipVariant; lat: 1 | -1; lon: 1 | -1 }> = [
  { variant: 'latitude', lat: -1, lon: 1 },
  { variant: 'longitude', lat: 1, lon: -1 },
  { variant: 'both', lat: -1, lon: -1 },
];

/** True for a finite, in-range coordinate that is not Null Island. */
function isUsablePoint(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
  precisionBits?: number | null,
): boolean {
  if (latitude == null || longitude == null) return false;
  return !isBogusPosition(latitude, longitude, precisionBits);
}

/**
 * Decide whether a reported position looks sign-flipped relative to
 * `reference`, and if so return the corrected point.
 *
 * Returns null (leave the position alone) when:
 * - the position or the reference is missing, out of range, or Null Island
 *   (including a precision-obscured (0, 0), via `precisionBits`);
 * - the range is not a positive finite number;
 * - the reported position is already within range;
 * - no mirror variant is within range, or two or more are (a node near the
 *   equator or the prime meridian is ambiguous, so it is never moved).
 */
export function detectSignFlip(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
  reference: LatLon | null | undefined,
  rangeKm: number,
  precisionBits?: number | null,
): SignFlipCorrection | null {
  if (!reference) return null;
  if (!Number.isFinite(rangeKm) || rangeKm <= 0) return null;
  if (!isUsablePoint(latitude, longitude, precisionBits)) return null;
  if (!isUsablePoint(reference.latitude, reference.longitude)) return null;
  const lat = latitude as number;
  const lon = longitude as number;

  const within = (la: number, lo: number): boolean =>
    calculateDistance(reference.latitude, reference.longitude, la, lo) <= rangeKm;

  if (within(lat, lon)) return null;

  let match: SignFlipCorrection | null = null;
  for (const v of VARIANTS) {
    const la = lat * v.lat;
    const lo = lon * v.lon;
    if (!within(la, lo)) continue;
    if (match) return null; // 2+ matches: ambiguous, leave it alone
    match = { latitude: la, longitude: lo, variant: v.variant };
  }
  return match;
}

function parseFiniteNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Clamp a range to {@link SIGN_FLIP_RANGE_KM}; junk becomes the default. */
export function clampSignFlipRangeKm(raw: unknown): number {
  const n = parseFiniteNumber(raw);
  if (n === null) return SIGN_FLIP_DEFAULT_RANGE_KM;
  return Math.min(SIGN_FLIP_RANGE_KM.max, Math.max(SIGN_FLIP_RANGE_KM.min, Math.round(n)));
}

/**
 * Parse the stored per-source settings. Off unless explicitly `'true'`/`'1'`.
 * A manual reference counts only when both halves are present and form a
 * usable point; otherwise the source's own node is the reference.
 */
export function parseSignFlipSettings(raw: {
  enabled?: string | null;
  rangeKm?: string | null;
  referenceLat?: string | null;
  referenceLon?: string | null;
}): SignFlipSettings {
  const enabled = raw.enabled === 'true' || raw.enabled === '1';
  const rangeKm = clampSignFlipRangeKm(raw.rangeKm);
  const lat = parseFiniteNumber(raw.referenceLat);
  const lon = parseFiniteNumber(raw.referenceLon);
  const manualReference = lat !== null && lon !== null && isUsablePoint(lat, lon)
    ? { latitude: lat, longitude: lon }
    : null;
  return { enabled, rangeKm, manualReference };
}

/**
 * Form check for the manual reference inputs: true when both are blank (use
 * the source's own node) or both form a valid coordinate pair.
 */
export function isSignFlipReferenceValid(lat: string, lon: string): boolean {
  const a = lat.trim();
  const b = lon.trim();
  if (a === '' && b === '') return true;
  if (a === '' || b === '') return false;
  return isValidLatLng(Number(a), Number(b));
}
