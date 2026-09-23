/**
 * Pure matching and collision logic for migration 171 (#5101) — reclassifying
 * existing `route_segments` record holders by transport, best-effort.
 *
 * Kept out of the migration so it is unit-tested without a database, and so
 * all three dialects (SQLite/PostgreSQL/MySQL) share one rule.
 */
import { parseHopArray } from './tracerouteSegments.js';
import { segmentTransportMechanism } from './tracerouteTransport.js';
import { classifyNodeTransport, type NodeTransportClass } from './nodeTransport.js';

export const RECLASSIFY_WINDOW_MS = 10 * 60 * 1000;

export interface BackfillSegment {
  fromNodeNum: number;
  toNodeNum: number;
  timestamp: number;
}

export interface BackfillTraceroute {
  fromNodeNum: number;
  toNodeNum: number;
  timestamp: number;
  route: string | null;
  routeBack: string | null;
  snrTowards: string | null;
  snrBack: string | null;
  transportMechanism: number | null;
}

export type BackfillMatch =
  | { matched: true; transportMechanism: number | null; tracerouteTimestamp: number }
  | { matched: false };

/** First index `i` such that `hops[i] === from && hops[i + 1] === to`, or null. */
function findPairIndex(hops: readonly number[], from: number, to: number): number | null {
  for (let i = 0; i < hops.length - 1; i++) {
    if (hops[i] === from && hops[i + 1] === to) return i;
  }
  return null;
}

/**
 * Find the traceroute that produced a stored segment, and derive the hop's
 * mechanism exactly as the live writer does (`segmentTransportMechanism`).
 *
 * Candidates: timestamp in `[seg.timestamp - RECLASSIFY_WINDOW_MS,
 * seg.timestamp]`. Every writer stamps segments with the traceroute's own
 * timestamp, so an exact match is expected; the window only absorbs clock
 * rounding. Rows NEWER than the segment are ignored: a later response
 * overwrites a pending row's route (finding 8 of the Phase 2 spec), so its
 * route is no longer the one that made the segment. Nearest (latest) match
 * first.
 *
 * Per candidate, the directed pair (`seg.from -> seg.to`) is searched in
 * these hop lists, each with its RAW SNR array index-aligned (hop `i`
 * arrives with `snr[i]`):
 *   forward  [toNodeNum, ...route, fromNodeNum]      + snrTowards   (direct-insert rows)
 *   forward' [fromNodeNum, ...route, toNodeNum]      + snrTowards   (pending-updated rows, finding 8)
 *   return   [fromNodeNum, ...routeBack, toNodeNum]  + snrBack      (MQTT return leg)
 *   return'  [toNodeNum, ...routeBack, fromNodeNum]  + snrBack
 * Unfiltered lists, as stored: MQTT keeps raw routes (placeholders included)
 * and TCP stores route/snr already filtered in step, so raw indexes align in
 * both. This also covers the old bootstrap writer, whose segments were
 * adjacent intermediate hops of the same list.
 *
 * First hit wins. Malformed JSON parses to `[]` (`parseHopArray`), so that
 * candidate simply does not match. A matched pre-#5097 traceroute (NULL
 * mechanism) still yields MQTT on a sentinel hop, else `null` (stays RF).
 */
export function matchSegmentTransport(
  segment: BackfillSegment,
  candidates: readonly BackfillTraceroute[],
): BackfillMatch {
  const windowStart = segment.timestamp - RECLASSIFY_WINDOW_MS;
  const inWindow = candidates
    .filter((tr) => tr.timestamp <= segment.timestamp && tr.timestamp >= windowStart)
    .slice()
    .sort((a, b) => b.timestamp - a.timestamp);

  for (const tr of inWindow) {
    const route = parseHopArray(tr.route);
    const routeBack = parseHopArray(tr.routeBack);
    const snrTowards = parseHopArray(tr.snrTowards);
    const snrBack = parseHopArray(tr.snrBack);

    const lists: Array<{ hops: number[]; snr: number[] }> = [
      { hops: [tr.toNodeNum, ...route, tr.fromNodeNum], snr: snrTowards }, // forward
      { hops: [tr.fromNodeNum, ...route, tr.toNodeNum], snr: snrTowards }, // forward'
      { hops: [tr.fromNodeNum, ...routeBack, tr.toNodeNum], snr: snrBack }, // return
      { hops: [tr.toNodeNum, ...routeBack, tr.fromNodeNum], snr: snrBack }, // return'
    ];

    for (const { hops, snr } of lists) {
      const idx = findPairIndex(hops, segment.fromNodeNum, segment.toNodeNum);
      if (idx !== null) {
        const rawSnr = idx < snr.length ? snr[idx] : undefined;
        return {
          matched: true,
          transportMechanism: segmentTransportMechanism(tr.transportMechanism, rawSnr),
          tracerouteTimestamp: tr.timestamp,
        };
      }
    }
  }

  return { matched: false };
}

export interface RecordHolderRow {
  id: number;
  sourceId: string | null;
  distanceKm: number;
  timestamp: number;
  transportMechanism: number | null;
}

/**
 * Records are now one per (source, class). Groups flagged rows by
 * `(sourceId, classifyNodeTransport({ transportMechanism }))` and returns
 * the ids to UNFLAG: all but the longest per group (tie -> newer timestamp,
 * then higher id). Pure; the migration applies the result.
 */
export function recordHolderIdsToDemote(rows: readonly RecordHolderRow[]): number[] {
  const groups = new Map<string, RecordHolderRow[]>();
  for (const row of rows) {
    const cls: NodeTransportClass = classifyNodeTransport({ transportMechanism: row.transportMechanism });
    const key = `${row.sourceId ?? '\u0000null'}\u0001${cls}`;
    const group = groups.get(key);
    if (group) {
      group.push(row);
    } else {
      groups.set(key, [row]);
    }
  }

  const demote: number[] = [];
  for (const group of groups.values()) {
    if (group.length <= 1) continue;

    let keeper = group[0];
    for (const row of group.slice(1)) {
      const longer = row.distanceKm > keeper.distanceKm;
      const tieNewer = row.distanceKm === keeper.distanceKm && row.timestamp > keeper.timestamp;
      const tieNewerTie = row.distanceKm === keeper.distanceKm
        && row.timestamp === keeper.timestamp
        && row.id > keeper.id;
      if (longer || tieNewer || tieNewerTie) keeper = row;
    }

    for (const row of group) {
      if (row.id !== keeper.id) demote.push(row.id);
    }
  }
  return demote;
}
