/**
 * Which source's position wins when a node is heard by several (#5292).
 *
 * A node heard on N sources has one `nodes` row per source, each holding that
 * source's own view of its position. The unified views have to pick one. Both
 * merges used to take the newest row by `lastHeard` that carried a fix, which
 * is wrong for a reason that only shows up in a multi-source deployment:
 * `lastHeard` is bumped by ANY traffic — telemetry, neighbour info, routing —
 * not just position packets. So a source holding an older, coarser fix would
 * become "newest" the moment it heard unrelated chatter, and the unified map
 * flipped to the coarser grid cell. The reported node moved by kilometres
 * without transmitting a new position: 14-bit (±1.5 km) and 13-bit (±2.9 km)
 * renderings of the same physical spot, alternating.
 *
 * The rule here:
 *   1. Only records with a usable fix are candidates (the caller decides what
 *      "usable" means, since the Null-Island policy differs per call site).
 *   2. Order by when the POSITION was observed — `positionTimestamp`, not
 *      `lastHeard`. Chatter can no longer promote a stale fix.
 *   3. Treat observations within `SAME_OBSERVATION_WINDOW_MS` as the same
 *      event, and among those prefer the finer `positionPrecisionBits`. This
 *      is the case that actually flaps: several sources receive the SAME
 *      transmission (one over RF, the rest relayed through MQTT) seconds
 *      apart, each storing it at whatever precision its path preserved.
 *   4. Fall back to `lastHeard`, then to input order, so a record that predates
 *      `positionTimestamp` being stored still sorts sensibly.
 *
 * A genuine move still wins immediately: a new fix outside the window sorts
 * first whatever its precision.
 */

/** Fields the ranking reads. Both the flat API shape and the DB row satisfy it. */
export interface PositionRankable {
  latitude?: number | null;
  longitude?: number | null;
  positionPrecisionBits?: number | null;
  positionTimestamp?: number | null;
  lastHeard?: number | null;
}

/**
 * How close two position observations must be to count as the same event.
 *
 * Sized for relay lag, not for how often a node transmits: the same packet
 * reaching a second source through an MQTT hop arrives seconds to minutes
 * later, and both rows then carry near-identical timestamps. Ten minutes
 * covers a slow relay while keeping a real move visible promptly — a node that
 * actually moved and re-transmitted is normally well outside it, and when it
 * is not, the cost is showing the finer of two fixes taken minutes apart.
 */
export const SAME_OBSERVATION_WINDOW_MS = 10 * 60 * 1000;

/**
 * When the position was observed, in ms.
 *
 * `positionTimestamp` is written in ms at ingest. `lastHeard` is SECONDS and
 * is only a fallback for rows written before the ingest path stored a position
 * timestamp — mixing the two units silently would put every legacy row ~1970,
 * or every current row ~56,000 years ahead.
 */
function observedAtMs(r: PositionRankable): number {
  if (typeof r.positionTimestamp === 'number' && Number.isFinite(r.positionTimestamp)) {
    return r.positionTimestamp;
  }
  if (typeof r.lastHeard === 'number' && Number.isFinite(r.lastHeard)) {
    return r.lastHeard * 1000;
  }
  return -Infinity;
}

function precisionOf(r: PositionRankable): number {
  return typeof r.positionPrecisionBits === 'number' && Number.isFinite(r.positionPrecisionBits)
    ? r.positionPrecisionBits
    : -Infinity;
}

/**
 * Pick the record whose position should represent the node, from candidates
 * the caller has already filtered down to usable fixes. Returns undefined for
 * an empty list. Input order breaks a total tie, so the result is stable.
 */
export function pickPositionRecord<T extends PositionRankable>(candidates: T[]): T | undefined {
  if (candidates.length === 0) return undefined;

  let best = candidates[0];
  let bestAt = observedAtMs(best);

  for (let i = 1; i < candidates.length; i++) {
    const r = candidates[i];
    const at = observedAtMs(r);

    if (Math.abs(at - bestAt) <= SAME_OBSERVATION_WINDOW_MS) {
      // Same observation as far as we can tell: finer precision wins, and a
      // newer timestamp only breaks a precision tie.
      const dp = precisionOf(r) - precisionOf(best);
      if (dp > 0 || (dp === 0 && at > bestAt)) {
        best = r;
        bestAt = at;
      }
      continue;
    }

    if (at > bestAt) {
      best = r;
      bestAt = at;
    }
  }

  return best;
}
