/**
 * Shared map-click resolution for pick-a-point map tools (#4727).
 *
 * "Click a node, or click anywhere" is the interaction both the Terrain Link
 * Profile and the Site Planner need: a click within `MAP_PICK_SNAP_PX` screen
 * pixels of a positioned node resolves to that node, anything else resolves to
 * the raw clicked coordinate.
 *
 * Extracted from `LinkProfileController` when the Site Planner needed the same
 * behaviour. Two copies of a snap threshold would drift silently — the tools
 * would start disagreeing about what counts as "on" a node, which is the kind
 * of inconsistency users feel but cannot describe.
 *
 * Screen-space rather than geographic distance is deliberate: the snap should
 * feel the same at every zoom level, and a fixed metre radius would be
 * unhittable when zoomed out and enormous when zoomed in.
 */
import type { Map as LeafletMap } from 'leaflet';
import { nearestPoint } from '../../utils/measureDistance';

/** Screen-space snap threshold (px) for treating a click as "on" a node. */
export const MAP_PICK_SNAP_PX = 24;

export interface PickCandidate {
  id: string;
  lat: number;
  lng: number;
}

export type PickedPoint<T extends PickCandidate> = (T | PickCandidate) & { isNode: boolean };

/**
 * Resolve a raw map click to either a nearby node or the clicked coordinate.
 *
 * Returns `null` for clicks on Leaflet controls (zoom, attribution, tileset
 * toggle) so those keep working while a pick tool is active — without this the
 * capture-phase listener swallows them and the map becomes unusable.
 */
export function resolvePickedPoint<T extends PickCandidate>(
  map: LeafletMap,
  e: MouseEvent,
  points: T[],
  snapPx: number = MAP_PICK_SNAP_PX,
): PickedPoint<T> | null {
  const target = e.target as HTMLElement | null;
  if (target && target.closest('.leaflet-control')) return null;

  const container = map.getContainer();
  const latlng = map.mouseEventToLatLng(e);
  const nearest = nearestPoint(points, latlng.lat, latlng.lng);

  if (nearest) {
    const rect = container.getBoundingClientRect();
    const clickPx = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const nearestPx = map.latLngToContainerPoint([nearest.lat, nearest.lng]);
    if (Math.hypot(clickPx.x - nearestPx.x, clickPx.y - nearestPx.y) < snapPx) {
      // Spread the candidate so callers keep whatever else it carried (name,
      // nodeNum, …) rather than being handed a bare coordinate.
      return { ...(nearest as T), isNode: true };
    }
  }

  return {
    id: `pt-${latlng.lat},${latlng.lng}`,
    lat: latlng.lat,
    lng: latlng.lng,
    isNode: false,
  };
}
