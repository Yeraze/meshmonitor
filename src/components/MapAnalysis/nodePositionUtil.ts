import { shouldDiscardPosition } from '../../utils/nullIsland';
import { getDiscardInvalidPositions } from '../../utils/positionDisplayConfig';

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
  altitude?: number | null;
  position?: {
    latitude?: number | null;
    longitude?: number | null;
    altitude?: number | null;
  } | null;
}

export function resolveNodeLatLng(
  node: MaybePositionedNode | null | undefined,
): [number, number] | null {
  if (!node) return null;
  const lat = node.latitude ?? node.position?.latitude;
  const lng = node.longitude ?? node.position?.longitude;
  if (lat == null || lng == null) return null;
  // Null Island (0,0) is normally dropped (uninitialized/stale GPS default,
  // #3763), but the global "Discard invalid positions" toggle can allow it so
  // operators can spot misconfigured nodes (#4157). Out-of-range junk is always
  // dropped regardless.
  if (shouldDiscardPosition(lat, lng, undefined, getDiscardInvalidPositions())) return null;
  return [lat, lng];
}

/**
 * Resolve a node's reported altitude (metres) from either the flat or nested
 * shape, mirroring `resolveNodeLatLng`. When a position override is enabled
 * the API folds the override into `position`, so this is the effective value.
 * Returns null when absent or non-finite.
 */
export function resolveNodeAltitude(node: MaybePositionedNode | null | undefined): number | null {
  if (!node) return null;
  const alt = node.altitude ?? node.position?.altitude;
  return typeof alt === 'number' && Number.isFinite(alt) ? alt : null;
}
