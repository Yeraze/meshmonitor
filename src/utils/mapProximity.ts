/**
 * Pixel-proximity hit test for canvas-rendered map markers (#5543).
 *
 * The Coverage Report draws receivers and fix dots as canvas `CircleMarker`s
 * (decision A6), and a canvas click only reaches the topmost marker, so
 * stacked markers hide the ones underneath. The map asks this helper which
 * markers sit near a click; when there is more than one it offers a chooser.
 *
 * Pure and Leaflet-free: the caller projects each marker to container pixels
 * first (`map.latLngToContainerPoint`).
 */

/** Default reach, in screen pixels, around the click point. */
export const PROXIMITY_TOLERANCE_PX = 10;

export interface ProximityCandidate<T> {
  /** Marker centre in container pixels. */
  x: number;
  y: number;
  /** Drawn radius in pixels. A big marker counts as hit anywhere inside it,
   *  even past the tolerance. */
  radius?: number;
  item: T;
}

export interface ProximityHit<T> {
  item: T;
  /** Pixel distance from the click to the marker centre. */
  distance: number;
}

/**
 * Every candidate whose centre lies within `max(tolerancePx, radius)` pixels
 * of `point`, nearest first. Ties keep input order (the sort is stable), so a
 * caller that lists markers in paint order gets a predictable list.
 */
export function findMarkersNearPoint<T>(
  point: { x: number; y: number },
  candidates: ReadonlyArray<ProximityCandidate<T>>,
  tolerancePx: number = PROXIMITY_TOLERANCE_PX,
): Array<ProximityHit<T>> {
  const hits: Array<ProximityHit<T>> = [];
  for (const c of candidates) {
    if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) continue;
    const distance = Math.hypot(c.x - point.x, c.y - point.y);
    const reach = Math.max(tolerancePx, c.radius ?? 0);
    if (distance <= reach) hits.push({ item: c.item, distance });
  }
  return hits.sort((a, b) => a.distance - b.distance);
}
