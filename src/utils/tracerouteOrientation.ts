/**
 * Traceroute row orientation — the ONE place that says which column is the
 * requester.
 *
 * ## What is stored
 *
 * `traceroutes.fromNodeNum` / `toNodeNum` do not have one meaning on disk.
 * The same completed run is stored one of two ways, depending on which writer
 * made the row:
 *
 *  - **Requester-first** `{ from: requester, to: responder }`.
 *    `recordTracerouteRequest` writes a pending row (`route` NULL) when a
 *    request goes out through MeshMonitor (the UI, auto-traceroute, an
 *    automation, a Virtual Node client). The reply then UPDATES that row in
 *    place and does not touch `from`/`to`.
 *  - **Reply-packet** `{ from: responder, to: requester }`. A reply that finds
 *    no pending row (the request came from a phone app, or the pending row
 *    timed out) is inserted as the packet arrived, and a reply's `from` is the
 *    node that answered. Every MQTT-observed row is written this way, and so
 *    is our own outgoing reply when another node traceroutes us.
 *
 * The four arrays are NOT affected. In both forms `route` / `snrTowards` run
 * from the requester toward the responder, and `routeBack` / `snrBack` run
 * back. So the same row read with the wrong endpoint order puts the first hop
 * next to the wrong end: with two or more hops it draws links that do not
 * exist, and with one hop it gives each link the other link's SNR.
 *
 * ## What readers get
 *
 * Every read method on `TraceroutesRepository` (and `AnalysisRepository.
 * getTraceroutes`) passes its rows through {@link orientTracerouteRow}, so a
 * reader always sees **requester-first** rows:
 *
 *   out:  [fromNodeNum, ...route, toNodeNum]       snrTowards[i] measured at out[i+1]
 *   back: [toNodeNum, ...routeBack, fromNodeNum]   snrBack[i]    measured at back[i+1]
 *
 * The `traceroute:complete` event is built from the reply packet, so the
 * emitter flips it with {@link replyPacketToRequesterFirst} before it leaves.
 *
 * Do not orient a row twice. A reply-packet row has no marker, so a second
 * pass flips it back. Rows from the repository are already oriented; only raw
 * rows (a direct table select, a test fixture) go through this helper.
 *
 * ## How the stored form is told apart
 *
 * Nothing on the row says which writer made it, so this reads the evidence:
 *
 *  1. `route` is NULL: a pending or unanswered request. Only
 *     `recordTracerouteRequest` writes those. Requester-first.
 *  2. `fromNodeNum` is the source's own radio AND the row has a return path:
 *     we sent it and the reply filled it in. Requester-first.
 *  3. Anything else is reply-packet form. That covers a reply with no pending
 *     row, every row on a source with no radio of its own (MQTT), a run
 *     between two other nodes, and our own outgoing reply (`from` is our
 *     radio, but no relay has filled the return leg yet, so rule 2 fails).
 *
 * Known limits, and why there is no migration: rule 2 needs the source's
 * CURRENT local node number, so a run sent before the radio on a source was
 * swapped reads as reply-packet form; and a reply our radio received with no
 * `snrBack` at all (firmware older than the SNR arrays) cannot be told from
 * our own outgoing reply. Stored fields alone cannot settle either case, so
 * the rows stay as written and the decision is made on read, where a better
 * rule can replace this one without having rewritten anyone's data.
 */
import { hasReturnPath, hasRouteData, parseHopArray } from './tracerouteSegments.js';

/** The columns orientation depends on. Node numbers may be BIGINT strings. */
export interface OrientableTraceroute {
  fromNodeNum: number | string;
  toNodeNum: number | string;
  fromNodeId?: string | null;
  toNodeId?: string | null;
  route?: string | null;
  routeBack?: string | null;
  snrBack?: string | null;
}

/**
 * True when the row AS STORED already has the requester in `fromNodeNum`.
 * `localNodeNum` is the node number of the radio on the row's source, or
 * null/undefined when the source has none (MQTT, never connected).
 */
export function isStoredRequesterFirst(
  row: OrientableTraceroute,
  localNodeNum: number | null | undefined,
): boolean {
  if (!hasRouteData(row.route)) return true;
  if (localNodeNum == null || !Number.isFinite(localNodeNum)) return false;
  if (Number(row.fromNodeNum) !== localNodeNum) return false;
  return hasReturnPath(parseHopArray(row.routeBack), row.snrBack);
}

/** Swap the endpoint columns. The route and SNR arrays are left alone. */
function swapEndpoints<T extends OrientableTraceroute>(row: T): T {
  const swapped = { ...row, fromNodeNum: row.toNodeNum, toNodeNum: row.fromNodeNum } as T;
  if ('fromNodeId' in row || 'toNodeId' in row) {
    const ids: OrientableTraceroute = swapped;
    ids.fromNodeId = row.toNodeId;
    ids.toNodeId = row.fromNodeId;
  }
  return swapped;
}

/**
 * A raw stored row -> requester-first. Returns the same object when the row
 * is already requester-first, a shallow copy with the endpoints swapped
 * otherwise. Call it ONCE per row (see the module doc).
 */
export function orientTracerouteRow<T extends OrientableTraceroute>(
  row: T,
  localNodeNum: number | null | undefined,
): T {
  return isStoredRequesterFirst(row, localNodeNum) ? row : swapEndpoints(row);
}

/**
 * A record built straight from a traceroute REPLY packet (`from` = the node
 * that answered) -> requester-first. No evidence needed: the caller knows
 * which form it holds.
 */
export function replyPacketToRequesterFirst<T extends OrientableTraceroute>(record: T): T {
  return swapEndpoints(record);
}
