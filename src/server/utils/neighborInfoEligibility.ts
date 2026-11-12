/**
 * Neighbor-info eligibility — is a node directly reachable?
 *
 * A NeighborInfo request to a multi-hop node re-broadcasts at every hop, so
 * `/neighborinfo/request` only allows the local node or a directly-heard
 * (0-hop) one. The original check read `nodes.hopsAway === 0` alone, but that
 * column reflects the LAST ordinary reception, which can be a relayed copy even
 * when the node is genuinely in direct range — so a node the user just traced
 * as a direct, 2-node link got denied (#6151).
 *
 * A completed traceroute is the stronger, fresher signal the user is looking
 * at: a direct link draws as a 2-node path with no intermediate hops. This
 * helper reads that same evidence, so the server honors what the Traceroute
 * panel shows.
 */

/**
 * Oldest direct traceroute that still proves a node is 0-hop (4.17.3 review
 * L5): 7 days. Older traces are ignored for NeighborInfo eligibility.
 */
export const NEIGHBOR_INFO_DIRECT_TRACE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Parse a traceroute `route` / `routeBack` JSON column to its hop array. */
function parseHopArray(json: string | null | undefined): number[] | null {
  if (json == null) return null;
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The subset of a traceroute row this check needs. Rows are requester-first
 *  (already oriented by `TraceroutesRepository`), newest first. */
export interface DirectPathTracerouteRow {
  route: string | null;
  routeBack: string | null;
}

/**
 * True when the most recent ANSWERED traceroute between the two nodes is a
 * direct, 0-hop path (no intermediate hops either way) — proof the node is in
 * direct RF range right now.
 *
 * - A pending/unanswered row (`route` null) is not evidence; skip it.
 * - The first answered row decides: a later direct trace is overridden by a
 *   newer multi-hop one (the node moved away), matching how `hopsAway` tracks
 *   the latest reception.
 * - `routeBack` may be absent on a one-way reply; a null back path does not
 *   contradict a direct forward path.
 */
export function tracerouteShowsDirectPath(rows: DirectPathTracerouteRow[]): boolean {
  for (const row of rows) {
    const forward = parseHopArray(row.route);
    if (forward == null) continue; // unanswered — not evidence
    const back = parseHopArray(row.routeBack);
    const backHops = back == null ? 0 : back.length;
    // Only the newest answered traceroute counts: return its verdict.
    return forward.length === 0 && backHops === 0;
  }
  return false;
}
