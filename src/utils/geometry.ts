/**
 * Geometry utilities for geofence calculations
 */

import { calculateDistance } from './distance.js';
import type { GeofenceShape } from '../components/auto-responder/types.js';

/**
 * Check if a point is inside a circle defined by a center and radius
 */
export function isPointInCircle(
  lat: number,
  lng: number,
  center: { lat: number; lng: number },
  radiusKm: number
): boolean {
  const distance = calculateDistance(lat, lng, center.lat, center.lng);
  return distance <= radiusKm;
}

/**
 * Check if a point is inside a polygon using the ray casting algorithm
 */
export function isPointInPolygon(
  lat: number,
  lng: number,
  vertices: Array<{ lat: number; lng: number }>
): boolean {
  if (vertices.length < 3) return false;

  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const xi = vertices[i].lng;
    const yi = vertices[i].lat;
    const xj = vertices[j].lng;
    const yj = vertices[j].lat;

    const intersect =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;

    if (intersect) inside = !inside;
  }

  return inside;
}

/**
 * Check if a point is inside a geofence shape (circle or polygon)
 */
export function isPointInGeofence(
  lat: number,
  lng: number,
  shape: GeofenceShape
): boolean {
  if (shape.type === 'circle') {
    return isPointInCircle(lat, lng, shape.center, shape.radiusKm);
  }
  return isPointInPolygon(lat, lng, shape.vertices);
}

/**
 * Get the center point of a geofence shape.
 * For circles, returns the center. For polygons, returns the centroid.
 */
export function getGeofenceCenter(shape: GeofenceShape): { lat: number; lng: number } {
  if (shape.type === 'circle') {
    return { lat: shape.center.lat, lng: shape.center.lng };
  }

  const n = shape.vertices.length;
  if (n === 0) return { lat: 0, lng: 0 };

  let latSum = 0;
  let lngSum = 0;
  for (const v of shape.vertices) {
    latSum += v.lat;
    lngSum += v.lng;
  }

  return { lat: latSum / n, lng: lngSum / n };
}

/**
 * Calculate distance from a point to the center of a geofence shape (in km)
 */
export function distanceToGeofenceCenter(
  lat: number,
  lng: number,
  shape: GeofenceShape
): number {
  const center = getGeofenceCenter(shape);
  return calculateDistance(lat, lng, center.lat, center.lng);
}
