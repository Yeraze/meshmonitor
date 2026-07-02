/**
 * Recency-based marker opacity (issue #3886).
 *
 * Instead of a hard include/exclude cutoff, node markers fade smoothly as their
 * last-heard timestamp gets older: fully opaque when fresh, fading toward a
 * floor as the timestamp approaches the "stale" boundary. Used by the Dashboard
 * map (fade as nodes near the max-age cutoff) and Map Analysis (fade across the
 * time-slider window).
 */

/** Oldest a faded marker gets — kept above 0 so aging nodes stay visible/clickable. */
export const MIN_MARKER_OPACITY = 0.25;

/**
 * Map a timestamp to an opacity in `[minOpacity, 1]`.
 *
 * `freshMs` is the timestamp treated as fully opaque (1.0); `staleMs` is the
 * timestamp treated as fully faded (`minOpacity`). Values newer than `freshMs`
 * clamp to 1.0 and values older than `staleMs` clamp to `minOpacity`. All three
 * timestamps must share the same unit (milliseconds).
 *
 * Returns `1` when `valueMs` is missing (no timestamp → no fade) or when the
 * fresh/stale boundaries are degenerate.
 */
export function markerAgeOpacity(
  freshMs: number,
  staleMs: number,
  valueMs: number | null | undefined,
  minOpacity: number = MIN_MARKER_OPACITY,
): number {
  if (valueMs == null || !Number.isFinite(valueMs)) return 1;
  if (!(freshMs > staleMs)) return 1;
  const frac = (valueMs - staleMs) / (freshMs - staleMs);
  const clamped = Math.max(0, Math.min(1, frac));
  return minOpacity + clamped * (1 - minOpacity);
}
