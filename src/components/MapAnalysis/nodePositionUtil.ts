import { isBogusPosition } from '../../utils/nullIsland';

/**
 * Resolve a node's lat/lng from either the flat API shape (`{latitude, longitude}`)
 * or a nested `position` object (some hooks return `{position: {latitude, longitude}}`).
 *
 * Returns null when neither pair is fully populated, or when the position is at
 * "Null Island" (0,0) — an uninitialized/stale GPS default that should not be
 * rendered on the map (issue #3763). Mirrors the pattern in
 * src/components/Dashboard/DashboardMap.tsx that handles both shapes.
 */
export interface MaybePositionedNode {
  latitude?: number | null;
  longitude?: number | null;
  position?: { latitude?: number | null; longitude?: number | null } | null;
}

export function resolveNodeLatLng(
  node: MaybePositionedNode | null | undefined,
): [number, number] | null {
  if (!node) return null;
  const lat = node.latitude ?? node.position?.latitude;
  const lng = node.longitude ?? node.position?.longitude;
  if (lat == null || lng == null) return null;
  if (isBogusPosition(lat, lng)) return null;
  return [lat, lng];
}
