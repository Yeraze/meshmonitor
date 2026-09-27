/**
 * Position-history downsampling (#4743).
 *
 * The map draws one `<Polyline>` AND one rich `<Popup>` per segment of a node's
 * position trail. A node using estimated positions has its location
 * recalculated every time a neighbour reports, so its history grows far faster
 * than a GPS node's — 15,000 fixes is reachable, which is ~15,000 polylines and
 * ~15,000 popups. That froze the UI for about a minute on mobile.
 *
 * Bounding the RENDER rather than the data is the right lever here. A time
 * window alone does not fix it: estimated positions accumulate so quickly that
 * even 24 hours can hold thousands of fixes. Capping the element count bounds
 * the DOM no matter how dense the history or how wide the window.
 *
 * Downsampling is visually near-lossless for this use — a trail drawn from 500
 * evenly-spaced fixes is indistinguishable from one drawn from 15,000 at any
 * zoom the map offers — but it IS lossy about intermediate detail, which is why
 * callers are expected to say so rather than present the trail as complete.
 */

/**
 * Evenly sample `items` down to at most `maxPoints`, always keeping the first
 * and last entries.
 *
 * One documented exception to "at most": `maxPoints` below 2 still returns two
 * entries (first and last) when the input has them, because a single point
 * draws no segment and callers of this are drawing lines. The cap is a
 * rendering budget, and one point is not a smaller drawing than two — it is no
 * drawing at all.
 *
 * Preserving the endpoints is load-bearing: the map legend reads the oldest and
 * newest timestamps off this array, so dropping either would misreport the
 * trail's time span while the line itself still looked right.
 */
export function downsamplePositionHistory<T>(items: T[], maxPoints: number): T[] {
  if (maxPoints < 2) return items.length <= 1 ? items.slice() : [items[0], items[items.length - 1]];
  if (items.length <= maxPoints) return items.slice();

  const last = items.length - 1;
  const out: T[] = [];
  // Distribute maxPoints-1 intervals across the range, then append the true
  // final item. Rounding can repeat an index near the end, so guard against
  // emitting the same element twice.
  const step = last / (maxPoints - 1);
  let previousIndex = -1;
  for (let i = 0; i < maxPoints - 1; i++) {
    const index = Math.round(i * step);
    if (index === previousIndex) continue;
    out.push(items[index]);
    previousIndex = index;
  }
  if (previousIndex !== last) out.push(items[last]);
  return out;
}

/**
 * Maximum trail segments rendered at once.
 *
 * 500 keeps the drawn line smooth at every zoom level the map exposes while
 * holding the element count somewhere a browser handles comfortably. This is a
 * rendering budget, not a data limit — the full history is still fetched and
 * still drives the legend's time span.
 */
export const MAX_RENDERED_POSITION_POINTS = 500;

/**
 * Maximum position fixes accumulated by the progressive history fetch.
 *
 * Lives beside the render budget so the relationship between them is visible:
 * this must stay comfortably ABOVE `MAX_RENDERED_POSITION_POINTS`, so the
 * drawn trail still spans the node's full recorded history and only detail
 * nothing consumes is dropped.
 *
 * Bounds the OTHER half of the #4743 freeze — walking all 50 pages meant 50
 * sequential round trips, each followed by a state update and a full re-render.
 */
export const MAX_ACCUMULATED_POSITION_FIXES = 5000;

/**
 * Render budget for a tracked asset's trail (#5354 Phase 2, decision D1).
 *
 * The server has already thinned the asset's whole retention window to at
 * most this many points, keeping turns and stops, so the client draws them
 * all rather than evenly resampling down to `MAX_RENDERED_POSITION_POINTS`.
 */
export const MAX_RENDERED_ASSET_POSITION_POINTS = 2000;

/** Minimal shape `segmentBreaks` needs. */
interface SegmentMarked {
  segmentStart?: boolean;
}

/**
 * For each rendered pair `(rendered[i], rendered[i + 1])`, whether it crosses
 * a gap-segment boundary (#5354 Phase 2), so the trail must not be drawn
 * between them. `rendered` must be an in-order subsequence of `source` (what
 * `downsamplePositionHistory` returns); a boundary fix that was sampled away
 * still breaks the pair that spans it.
 *
 * Returns an array of length `rendered.length - 1` (empty for fewer than two).
 */
export function segmentBreaks<T extends SegmentMarked>(source: T[], rendered: T[]): boolean[] {
  if (rendered.length < 2) return [];
  const breaks: boolean[] = [];
  let j = source.indexOf(rendered[0]);
  if (j < 0) j = 0;
  for (let i = 1; i < rendered.length; i++) {
    let crossed = false;
    // Walk the source forward to rendered[i], noting any segment start passed.
    for (j = j + 1; j < source.length; j++) {
      if (source[j].segmentStart) crossed = true;
      if (source[j] === rendered[i]) break;
    }
    breaks.push(crossed);
  }
  return breaks;
}

/**
 * Flatten a tracked asset's gap segments (#5354 Phase 2) into the map's single
 * `positionHistory` array. The first fix of every segment after the first
 * carries `segmentStart: true`, so the trail renderer knows not to join it to
 * the fix before.
 */
export function flattenAssetTrack<T extends object>(segments: T[][]): Array<T & SegmentMarked> {
  const out: Array<T & SegmentMarked> = [];
  segments.forEach((segment, s) => {
    segment.forEach((fix, i) => {
      out.push(s > 0 && i === 0 ? { ...fix, segmentStart: true } : fix);
    });
  });
  return out;
}
