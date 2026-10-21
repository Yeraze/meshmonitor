/**
 * Waypoint geofence fields (#5922): firmware `Waypoint` fields 9-13.
 *
 * Pure helpers with no database or manager imports, so the route, the
 * service, and the protobuf encoder can all share them.
 *
 * Each receiving node evaluates the geofence itself and raises its own
 * alerts; there is no over-the-air geofence event. MeshMonitor stores the
 * fields so a waypoint from another client keeps them, and sends them so a
 * rebroadcast or an edit made here does not strip them.
 */
import type { Waypoint, WaypointBoundingBox } from '../../db/repositories/waypoints.js';

/** Pick the first defined value of a field that may arrive in either casing. */
function pickNumber(...candidates: (number | bigint | undefined | null)[]): number | undefined {
  for (const v of candidates) {
    if (v === undefined || v === null) continue;
    return Number(v);
  }
  return undefined;
}

/** The decoded Waypoint fields this module reads (protobufjs camelCase or snake_case). */
export interface DecodedWaypointGeofenceFields {
  geofenceRadius?: number;
  geofence_radius?: number;
  boundingBox?: DecodedBoundingBox | null;
  bounding_box?: DecodedBoundingBox | null;
  notifyOnEnter?: boolean;
  notify_on_enter?: boolean;
  notifyOnExit?: boolean;
  notify_on_exit?: boolean;
  notifyFavoritesOnly?: boolean;
  notify_favorites_only?: boolean;
}

export interface DecodedBoundingBox {
  longitudeWestI?: number;
  longitude_west_i?: number;
  latitudeSouthI?: number;
  latitude_south_i?: number;
  longitudeEastI?: number;
  longitude_east_i?: number;
  latitudeNorthI?: number;
  latitude_north_i?: number;
}

/** The geofence part of a waypoint (#5922). */
export interface WaypointGeofence {
  geofenceRadiusM: number | null;
  boundingBox: WaypointBoundingBox | null;
  notifyOnEnter: boolean;
  notifyOnExit: boolean;
  notifyFavoritesOnly: boolean;
}

/**
 * Radius range the editor and API accept, in metres: Apple's 0.1-10 mile
 * range, so a waypoint made here looks the same in every client (#5922).
 * Radii from the mesh are stored as sent.
 */
export const WAYPOINT_GEOFENCE_MIN_RADIUS_M = 160;
export const WAYPOINT_GEOFENCE_MAX_RADIUS_M = 16000;

/** Read the geofence fields of an inbound Waypoint. Absent fields mean "none". */
export function decodeWaypointGeofence(decoded: DecodedWaypointGeofenceFields): WaypointGeofence {
  const radius = pickNumber(decoded.geofenceRadius, decoded.geofence_radius) ?? 0;
  const bb = decoded.boundingBox ?? decoded.bounding_box ?? null;
  let boundingBox: WaypointBoundingBox | null = null;
  if (bb) {
    const west = pickNumber(bb.longitudeWestI, bb.longitude_west_i);
    const south = pickNumber(bb.latitudeSouthI, bb.latitude_south_i);
    const east = pickNumber(bb.longitudeEastI, bb.longitude_east_i);
    const north = pickNumber(bb.latitudeNorthI, bb.latitude_north_i);
    // An all-zero box is proto3's empty message, not a real region.
    if (
      west !== undefined && south !== undefined && east !== undefined && north !== undefined &&
      !(west === 0 && south === 0 && east === 0 && north === 0)
    ) {
      boundingBox = { west: west / 1e7, south: south / 1e7, east: east / 1e7, north: north / 1e7 };
    }
  }
  return {
    geofenceRadiusM: radius > 0 ? radius : null,
    boundingBox,
    notifyOnEnter: Boolean(decoded.notifyOnEnter ?? decoded.notify_on_enter),
    notifyOnExit: Boolean(decoded.notifyOnExit ?? decoded.notify_on_exit),
    notifyFavoritesOnly: Boolean(decoded.notifyFavoritesOnly ?? decoded.notify_favorites_only),
  };
}

/** Fields `broadcastWaypoint` sends for a stored waypoint. */
export interface WireWaypoint {
  id: number;
  latitude: number;
  longitude: number;
  expire: number;
  lockedTo?: number;
  name?: string;
  description?: string;
  icon?: number;
  geofenceRadiusM?: number | null;
  boundingBox?: WaypointBoundingBox | null;
  notifyOnEnter?: boolean;
  notifyOnExit?: boolean;
  notifyFavoritesOnly?: boolean;
}

/** Build the broadcast payload for a stored waypoint, geofence included (#5922). */
export function toWireWaypoint(w: Waypoint): WireWaypoint {
  return {
    id: w.waypointId,
    latitude: w.latitude,
    longitude: w.longitude,
    expire: w.expireAt ?? 0,
    lockedTo: w.lockedTo ?? 0,
    name: w.name,
    description: w.description,
    icon: w.iconCodepoint ?? 0,
    geofenceRadiusM: w.geofenceRadiusM,
    boundingBox: w.boundingBox,
    notifyOnEnter: w.notifyOnEnter,
    notifyOnExit: w.notifyOnExit,
    notifyFavoritesOnly: w.notifyFavoritesOnly,
  };
}

