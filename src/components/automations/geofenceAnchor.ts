/**
 * Waypoint-anchored geofence value (#4722) — the client half of the type the
 * engine resolves in `src/server/services/automation/geo.ts`.
 *
 * Deliberately NOT added to the `GeofenceShape` union in
 * `src/components/auto-responder/types.ts`: that union is shared with the
 * Meshtastic geofence-alert UI, which has no waypoint concept and narrows on
 * `type` exhaustively. Widening it there would silently change behaviour in a
 * feature this issue never touched.
 *
 * `sourceId` is part of the value because automations are global while
 * waypoints are per-source — see the engine-side note for why the fence pins
 * its source rather than following the moving node's.
 */
export interface GeofenceWaypointAnchor {
  type: 'waypoint';
  sourceId: string;
  waypointId: number;
  radiusKm: number;
}

/** The two things a geofence field can hold: a drawn region, or an anchor. */
export type GeofenceFieldValue = { type: 'circle' | 'polygon' } | GeofenceWaypointAnchor;

export function isWaypointAnchor(v: unknown): v is GeofenceWaypointAnchor {
  return !!v && typeof v === 'object' && (v as { type?: unknown }).type === 'waypoint';
}

/**
 * True when the anchor is complete enough for the engine to resolve. Mirrors
 * `normalizeGeofenceAnchor` server-side: a blank source or non-positive radius
 * yields a fence that can never fire, so the editor should not call it valid.
 * Waypoint id 0 IS valid — it is a real id, not "unset".
 */
export function isCompleteAnchor(a: Partial<GeofenceWaypointAnchor> | undefined): boolean {
  if (!a) return false;
  if (typeof a.sourceId !== 'string' || a.sourceId.trim() === '') return false;
  if (!Number.isFinite(a.waypointId)) return false;
  return Number.isFinite(a.radiusKm) && (a.radiusKm as number) > 0;
}
