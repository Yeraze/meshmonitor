/**
 * Marker density for telemetry line charts (#5196).
 *
 * A telemetry card is ~300px wide in phone portrait and the series behind it can
 * be 24 hours of samples. At a fixed `r: 3` every marker is 6px across, so a few
 * hundred of them overlap into one solid band — the reporter's voltage plateau
 * rendered as a blob with no readable line and no way to zoom or scrub. The same
 * markers are genuinely useful on a sparse series (the noise-floor chart), so
 * dropping them outright is the wrong trade.
 *
 * Scale the marker to the room each point actually gets instead: full size while
 * points are comfortably apart, a small dot while they are tight, and line-only
 * once they would overlap. `activeDot` is unaffected, so tapping a point still
 * highlights it and opens the tooltip at every density.
 */

/** Width the Y axis and the chart's right margin take out of the container. */
const AXIS_ALLOWANCE_PX = 70;

/** Spacing at or above which a full-size (r: 3) marker still reads as a marker. */
const FULL_MARKER_SPACING_PX = 10;

/** Spacing at or above which a reduced (r: 1.5) marker is still worth drawing. */
const SMALL_MARKER_SPACING_PX = 4;

export const FULL_MARKER_RADIUS = 3;
export const SMALL_MARKER_RADIUS = 1.5;

/**
 * Marker radius for a series, or `null` for line-only.
 *
 * @param pointCount      number of points the series will render
 * @param containerWidth  measured width of the chart container in px; `0` when
 *                        it has not been measured yet (server render, first
 *                        paint, or a jsdom test without ResizeObserver), which
 *                        keeps the previous full-size markers rather than
 *                        flashing a line-only chart.
 */
export function telemetryMarkerRadius(pointCount: number, containerWidth: number): number | null {
  if (containerWidth <= 0) return FULL_MARKER_RADIUS;
  if (pointCount <= 1) return FULL_MARKER_RADIUS;

  const plotWidth = Math.max(containerWidth - AXIS_ALLOWANCE_PX, 0);
  if (plotWidth <= 0) return null;

  const spacing = plotWidth / (pointCount - 1);
  if (spacing >= FULL_MARKER_SPACING_PX) return FULL_MARKER_RADIUS;
  if (spacing >= SMALL_MARKER_SPACING_PX) return SMALL_MARKER_RADIUS;
  return null;
}

/**
 * Recharts `dot` prop for a series: `false` for line-only, otherwise a marker
 * spec in the series colour.
 */
export function telemetryDotProp(
  pointCount: number,
  containerWidth: number,
  fill: string,
): false | { fill: string; r: number } {
  const r = telemetryMarkerRadius(pointCount, containerWidth);
  return r === null ? false : { fill, r };
}
