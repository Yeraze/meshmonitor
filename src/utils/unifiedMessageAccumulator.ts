/**
 * Accumulator for the unified message feed.
 *
 * The `/api/unified/messages` endpoint is a capped *newest-N* window: each poll
 * returns the most recent page, deduplicated across sources. Rendering directly
 * off the latest poll means a message that scrolls past that window on a later
 * poll silently vanishes from the view — even though the user already saw it and
 * the row still exists in the DB. This is the root of #3719/#3720: a message
 * exclusive to a high-traffic source (e.g. a continental MQTT bridge) gets
 * pushed past the window within ~60s as newer messages arrive.
 *
 * The structural fix is to make the live feed *append-only*: fold every poll's
 * pages into a persistent map keyed by `dedupKey` and render from that, so once
 * a message is shown it stays shown regardless of how the server window shifts.
 * This decouples display persistence from the server window size entirely.
 */

/** Minimal shape the accumulator needs; the full `UnifiedMessage` is a superset. */
export interface AccumulableMessage {
  dedupKey: string;
  createdAt: number;
}

/**
 * Default cap on retained entries. Generous so realistic scroll-back never trims
 * live history; only pathological sessions (very long live tail or massive
 * scroll-back) hit it, and trimmed entries remain re-fetchable via scroll-back.
 */
export const DEFAULT_ACCUMULATOR_CAP = 5000;

/**
 * Fold freshly-fetched pages into a persistent accumulator and return the merged
 * list sorted ascending by `createdAt` (oldest → newest, so the chat layout pins
 * the newest message to the bottom).
 *
 * - **Upserts by `dedupKey`:** a later poll may carry a more-complete merged
 *   object (extra `receptions`, ack state, upgraded sender names), so the newest
 *   copy of a given key wins.
 * - **Never removes on poll:** a key absent from the current pages is retained —
 *   that is exactly what keeps a scrolled-out message visible (#3719).
 * - **Caps memory:** when the set exceeds `cap`, the OLDEST entries (by
 *   `createdAt`) are dropped.
 *
 * Mutates `acc` in place (so the caller can persist it across renders via a ref)
 * and returns the sorted snapshot.
 */
export function foldUnifiedMessagePages<T extends AccumulableMessage>(
  acc: Map<string, T>,
  pages: T[][] | undefined,
  cap: number = DEFAULT_ACCUMULATOR_CAP,
): T[] {
  if (pages) {
    for (const page of pages) {
      for (const m of page) acc.set(m.dedupKey, m);
    }
  }

  let out = Array.from(acc.values());
  out.sort((a, b) => a.createdAt - b.createdAt);

  if (out.length > cap) {
    out = out.slice(out.length - cap); // keep the newest `cap`
    acc.clear();
    for (const m of out) acc.set(m.dedupKey, m);
  }

  return out;
}
