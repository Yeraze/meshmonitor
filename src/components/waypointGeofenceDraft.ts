/**
 * Waypoint editor geofence draft (#5922): the form state for firmware
 * Waypoint fields 9-13, and its conversion to and from the API shape.
 */
import type { WaypointBoundingBox } from '../types/waypoint';

/** Editor and API radius range, in metres: Apple's 0.1-10 miles. */
export const GEOFENCE_MIN_RADIUS_M = 160;
export const GEOFENCE_MAX_RADIUS_M = 16000;
/** Radius a new circle starts with. */
export const DEFAULT_GEOFENCE_RADIUS_M = 500;

export type GeofenceShapeChoice = 'none' | 'circle' | 'box' | 'both';

export interface GeofenceDraft {
  shape: GeofenceShapeChoice;
  radiusM: number | null;
  box: WaypointBoundingBox | null;
  notifyOnEnter: boolean;
  notifyOnExit: boolean;
  notifyFavoritesOnly: boolean;
}

export const EMPTY_GEOFENCE: GeofenceDraft = {
  shape: 'none',
  radiusM: null,
  box: null,
  notifyOnEnter: false,
  notifyOnExit: false,
  notifyFavoritesOnly: false,
};

/** Seed the draft from a stored waypoint. */
export function geofenceDraftFrom(w: {
  geofenceRadiusM?: number | null;
  boundingBox?: WaypointBoundingBox | null;
  notifyOnEnter?: boolean;
  notifyOnExit?: boolean;
  notifyFavoritesOnly?: boolean;
}): GeofenceDraft {
  const radiusM = w.geofenceRadiusM && w.geofenceRadiusM > 0 ? w.geofenceRadiusM : null;
  const box = w.boundingBox ?? null;
  // Firmware allows a circle and a box together; keep both rather than drop one.
  const shape: GeofenceShapeChoice = radiusM && box ? 'both' : radiusM ? 'circle' : box ? 'box' : 'none';
  return {
    shape,
    radiusM,
    box,
    notifyOnEnter: Boolean(w.notifyOnEnter),
    notifyOnExit: Boolean(w.notifyOnExit),
    notifyFavoritesOnly: Boolean(w.notifyFavoritesOnly),
  };
}

/** The draft as body fields, or an error message. */
export function geofenceBody(d: GeofenceDraft):
  | {
      geofence_radius_m: number | null;
      bounding_box: WaypointBoundingBox | null;
      notify_on_enter: boolean;
      notify_on_exit: boolean;
      notify_favorites_only: boolean;
    }
  | { error: string } {
  const wantsCircle = d.shape === 'circle' || d.shape === 'both';
  const wantsBox = d.shape === 'box' || d.shape === 'both';
  if (wantsCircle) {
    const r = d.radiusM;
    if (r == null || !Number.isInteger(r) || r < GEOFENCE_MIN_RADIUS_M || r > GEOFENCE_MAX_RADIUS_M) {
      return { error: `Geofence radius must be ${GEOFENCE_MIN_RADIUS_M}-${GEOFENCE_MAX_RADIUS_M} m` };
    }
  }
  if (wantsBox && !d.box) return { error: 'Draw the geofence box on the map' };
  const hasShape = d.shape !== 'none';
  return {
    geofence_radius_m: wantsCircle ? d.radiusM : null,
    bounding_box: wantsBox ? d.box : null,
    // Alerts need a region to cross.
    notify_on_enter: hasShape && d.notifyOnEnter,
    notify_on_exit: hasShape && d.notifyOnExit,
    notify_favorites_only: hasShape && (d.notifyOnEnter || d.notifyOnExit) && d.notifyFavoritesOnly,
  };
}
