/**
 * Pure helpers for GeofenceMapEditor, kept out of the .tsx so they can be
 * exported and unit-tested (react-refresh/only-export-components).
 */
import L from 'leaflet';
import { GEOFENCE_RADIUS_KM_MAX } from '../utils/geofenceLimits';

/** Radius a new circle gets when the fields leave it empty (matches click-to-create). */
export const DEFAULT_RADIUS_KM = 10;

/**
 * How long typing in the Lat/Lng/Radius fields must pause before the typed
 * value moves the circle. Blur and Enter apply it at once. Without the wait,
 * each valid prefix was applied: typing "123" moved the circle to lat 12
 * before "123" failed validation.
 */
export const GEOFENCE_FIELD_COMMIT_DELAY_MS = 400;

/** Leaflet's own Earth radius (L.CRS.Earth.R), so distanceTo() and circleEdgePoint() agree. */
export const EARTH_RADIUS_M = 6371000;

/** A non-empty field whose number is missing or outside [min, max]. */
export function isOutOfRange(value: string, min: number, max: number): boolean {
  if (value.trim() === '') return false;
  const n = parseFloat(value);
  return Number.isNaN(n) || n < min || n > max;
}

/** A non-empty radius that is not a positive number (above-max is clamped, not flagged). */
export function isInvalidRadius(value: string): boolean {
  if (value.trim() === '') return false;
  const n = parseFloat(value);
  return Number.isNaN(n) || n <= 0;
}

export function clampRadiusMeters(meters: number): number {
  return Math.min(GEOFENCE_RADIUS_KM_MAX * 1000, meters);
}

/**
 * The point due east of `center` at `radiusMeters` along the sphere, i.e. on
 * the circle's edge. The old `lng + r / 111320` ignored cos(latitude), so away
 * from the equator the radius handle sat outside the circle.
 */
export function circleEdgePoint(center: L.LatLng, radiusMeters: number): L.LatLng {
  const d = radiusMeters / EARTH_RADIUS_M;
  const lat1 = (center.lat * Math.PI) / 180;
  const lng1 = (center.lng * Math.PI) / 180;
  const bearing = Math.PI / 2;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(bearing));
  const lng2 = lng1 + Math.atan2(
    Math.sin(bearing) * Math.sin(d) * Math.cos(lat1),
    Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
  );
  return L.latLng((lat2 * 180) / Math.PI, (lng2 * 180) / Math.PI);
}
