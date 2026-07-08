/**
 * Pure helpers for the node-to-node line-of-sight (LOS) distance measurement
 * tool (issue #3636). Kept free of react-leaflet so they can be unit tested in
 * isolation; the interactive UI lives in
 * `src/components/MeasureDistanceController.tsx`.
 */
import { calculateDistance, formatDistance } from './distance';

/**
 * A candidate endpoint for a measurement. Each map builds these from its own
 * positioned-node memo, so `id`/`label` shapes vary — only lat/lng matter for
 * the geometry.
 */
export interface MeasurePoint {
  id: string;
  lat: number;
  lng: number;
  label?: string;
}

/**
 * Find the point nearest to (lat, lng) by great-circle distance.
 * Returns null for an empty list. On a tie the earlier point wins.
 */
export function nearestPoint(
  points: MeasurePoint[],
  lat: number,
  lng: number
): MeasurePoint | null {
  let best: MeasurePoint | null = null;
  let bestKm = Infinity;
  for (const p of points) {
    const km = calculateDistance(lat, lng, p.lat, p.lng);
    if (km < bestKm) {
      bestKm = km;
      best = p;
    }
  }
  return best;
}

/**
 * Format the straight-line distance between two measured points, honoring the
 * user's km/mi preference.
 */
export function measureLabel(
  a: MeasurePoint,
  b: MeasurePoint,
  unit: 'km' | 'mi'
): string {
  const km = calculateDistance(a.lat, a.lng, b.lat, b.lng);
  return formatDistance(km, unit);
}

/**
 * Midpoint (simple average) of two points, used to anchor the distance label.
 * Adequate for the short LOS spans typical of a mesh network.
 */
export function midpoint(a: MeasurePoint, b: MeasurePoint): [number, number] {
  return [(a.lat + b.lat) / 2, (a.lng + b.lng) / 2];
}
