/**
 * Pure zoom/animation math shared by `MapCenterController` and
 * `useMarkerSpiderfier`'s zoom-gated "click to zoom in" flow (issue #4046,
 * items 2/3/4). Kept dependency-free (no Leaflet/React imports) so it's
 * trivially unit-testable and reusable from both call sites.
 */

/**
 * Default target zoom used when centering on a single node (issue #4046
 * item 2). Tighter than the old hardcoded 15 since the user is selecting one
 * specific node. User-configurable via the `mapCenterTargetZoom` setting —
 * see `SettingsContext`/`SettingsTab`.
 */
export const DEFAULT_TARGET_ZOOM = 17;

/**
 * Zoom level at/above which markers are registered with the spiderfier
 * (issue #4046 item 4). Below this, a marker click zooms in first instead of
 * spiderfying a large, hard-to-parse low-zoom pile.
 */
export const DEFAULT_ZOOM_GATE_THRESHOLD = 13;

/** Base animation duration (seconds) for a zero/near-zero zoom-delta pan. */
export const ZOOM_ANIMATION_DURATION_BASE_SECONDS = 0.5;

/**
 * Growth factor applied per zoom level of delta — `duration = base *
 * factor^delta`, capped at ZOOM_ANIMATION_DURATION_MAX_SECONDS. Tuned so a
 * 1-2 level nudge stays snappy (~0.56-0.63s) while a full zoomed-out-to-street
 * jump (delta 10+) saturates at the cap rather than dragging on:
 *   delta 1  -> 0.56s
 *   delta 2  -> 0.63s
 *   delta 5  -> 0.88s
 *   delta 10 -> 1.55s
 *   delta 15 -> capped at 2.0s
 */
export const ZOOM_ANIMATION_DURATION_GROWTH_FACTOR = 1.12;

/** Upper bound (seconds) on the scaled animation duration — keeps even a
 *  world-to-street jump feeling snappy rather than sluggish. */
export const ZOOM_ANIMATION_DURATION_MAX_SECONDS = 2.0;

/**
 * Clamp a target zoom so centering on a node never forces a zoom-*out*
 * (issue #4046 item 2). Zooms in when the user is further out than
 * `targetZoom`; leaves the current zoom untouched (pure pan) when already
 * closer.
 */
export function computeClampedTargetZoom(currentZoom: number, targetZoom: number): number {
  return Math.max(currentZoom, targetZoom);
}

/**
 * Scale the pan/zoom animation duration by the size of the zoom jump (issue
 * #4046 item 3) so a big jump doesn't feel like a jarring snap while a small
 * nudge stays quick.
 */
export function computeZoomAnimationDuration(currentZoom: number, targetZoom: number): number {
  const delta = Math.abs(targetZoom - currentZoom);
  const duration = ZOOM_ANIMATION_DURATION_BASE_SECONDS * Math.pow(ZOOM_ANIMATION_DURATION_GROWTH_FACTOR, delta);
  return Math.min(duration, ZOOM_ANIMATION_DURATION_MAX_SECONDS);
}

/**
 * Resolve the user-configurable `mapZoomGateThreshold` setting into the value
 * `NodeMarkerCluster`'s `disableClusteringAtZoom` (and the spiderfier's own
 * `zoomGateThreshold`, see `NodeMarkersLayer`'s `effectiveSpiderfierOptions`)
 * expect: `0` means "no gate at all", which both systems already spell as
 * `undefined` rather than a numeric zoom (issue #4551, PR #5284 review item
 * 1). Shared here so the map-marker cluster wrapper and the spiderfier gate
 * read the SAME setting the SAME way instead of each inventing its own
 * reading of `0`.
 */
export function resolveClusterZoomThreshold(mapZoomGateThreshold: number): number | undefined {
  return mapZoomGateThreshold > 0 ? mapZoomGateThreshold : undefined;
}

/**
 * PR #5284 review item 3: a node selected from the list must still be able
 * to open its popup even when `mapCenterTargetZoom` is set below the
 * cluster's own disable-clustering zoom. `MapCenterController` clamps to
 * `max(currentZoom, targetZoom)` (`computeClampedTargetZoom`); if that lands
 * below `clusterZoomThreshold`, the target marker is still clustered —
 * removed from the map as an individual layer entirely — so
 * `marker.openPopup()` silently does nothing.
 *
 * Raises the effective target zoom to at least the cluster threshold
 * whenever clustering is active, so `MapCenterController` always lands
 * somewhere the marker is guaranteed to be a real, individual layer. `null`/
 * `undefined` `clusterZoomThreshold` (clustering off — see
 * `resolveClusterZoomThreshold`) leaves `mapCenterTargetZoom` untouched.
 *
 * Chosen over `clusterGroup.zoomToShowLayer()` as the less invasive of the
 * two fixes the maintainer suggested: no cluster-group ref needs to be
 * threaded out to the separate "open popup for selected node" effect, and it
 * also fixes the in-map OMS click path for free since both flows share one
 * `<MapCenterController targetZoom>`.
 */
export function resolveClusteredMapCenterTargetZoom(
  mapCenterTargetZoom: number,
  clusterZoomThreshold: number | null | undefined
): number {
  return clusterZoomThreshold != null
    ? Math.max(mapCenterTargetZoom, clusterZoomThreshold)
    : mapCenterTargetZoom;
}

/** A projected screen-space point, structurally compatible with `L.Point`. */
export interface ScreenPoint {
  x: number;
  y: number;
}

/**
 * True when any point in `others` lies within `nearbyDistancePx` of `target`
 * (issue #4551).
 *
 * This is the density half of the zoom gate: below `zoomGateThreshold` a
 * marker click only needs the "zoom in first" detour when there is actually
 * something nearby to disambiguate it from. An isolated marker — the reported
 * case, a node 200km from anything else — has nothing to separate, so it can
 * open its popup directly at any zoom.
 *
 * Distances are in projected layer pixels, matching how OMS itself decides
 * what overlaps (`nearbyDistance`). Layer-point deltas depend only on zoom,
 * not on pan, so a given pair's neighbour-ness is stable while panning.
 *
 * Comparison is `<=` so the boundary case counts as nearby, and squared
 * distances are compared to skip a `Math.sqrt` per candidate — this runs over
 * every tracked marker on each gated click.
 */
export function hasNearbyPoint(
  target: ScreenPoint,
  others: Iterable<ScreenPoint>,
  nearbyDistancePx: number,
): boolean {
  // A non-positive radius means "nothing is ever nearby" — treat every marker
  // as isolated rather than letting `0 <= 0` match a marker against itself.
  if (!(nearbyDistancePx > 0)) return false;
  const limitSquared = nearbyDistancePx * nearbyDistancePx;
  for (const other of others) {
    const dx = other.x - target.x;
    const dy = other.y - target.y;
    if (dx * dx + dy * dy <= limitSquared) return true;
  }
  return false;
}
