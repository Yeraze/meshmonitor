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
