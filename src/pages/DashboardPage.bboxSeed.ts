/**
 * Pure helpers used by the mqtt_bridge geofence editor inside DashboardPage.
 *
 * Extracted here so the unit tests can import them without dragging in the
 * full React component tree (which depends on JSDOM globals).
 */
import type { BBoxValue } from '../components/BBoxMapEditor';

export function bboxToFormStrings(b: BBoxValue): {
  minLat: string;
  maxLat: string;
  minLng: string;
  maxLng: string;
} {
  return {
    minLat: b.minLat.toFixed(5),
    maxLat: b.maxLat.toFixed(5),
    minLng: b.minLng.toFixed(5),
    maxLng: b.maxLng.toFixed(5),
  };
}

/**
 * Compute a bbox enclosing all nodes that report a real position, with a
 * 10% padding (clamped to a minimum of 0.05° ≈ 5km) so the rectangle isn't
 * razor-tight on the outermost nodes. Used to seed the geofence bbox when
 * the user first enables the geographic filter — sticking them at (0,0)
 * in the middle of the ocean on a fresh checkbox click is useless.
 *
 * Nodes at exactly (0,0) are treated as "no fix" and skipped: this is the
 * sentinel value firmware reports when GPS hasn't locked yet, and lumping
 * it in would balloon the bbox out to the Atlantic.
 */
export function boundsFromDetectedNodes(
  nodes: ReadonlyArray<{ latitude?: number | null; longitude?: number | null }>,
): BBoxValue | null {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  let count = 0;
  for (const n of nodes) {
    const lat = n.latitude;
    const lng = n.longitude;
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    if (lat === 0 && lng === 0) continue;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    count++;
  }
  if (count === 0) return null;
  const padLat = Math.max(0.05, (maxLat - minLat) * 0.1);
  const padLng = Math.max(0.05, (maxLng - minLng) * 0.1);
  return {
    minLat: minLat - padLat,
    maxLat: maxLat + padLat,
    minLng: minLng - padLng,
    maxLng: maxLng + padLng,
  };
}
