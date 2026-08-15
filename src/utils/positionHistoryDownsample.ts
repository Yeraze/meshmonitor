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
