/**
 * Traceroute-confirmed reciprocal links (#5580).
 *
 * The cross-source "heard here" layer (#5561) records one-way receptions
 * between our OWN sources. It cannot show that a REMOTE node hears us: that
 * proof only exists in a traceroute's return path. This module reads it out.
 *
 * ## The rule
 *
 * A completed traceroute a source ran has two legs:
 *
 *   out:  [us, ...route, destination]         snrTowards[i] measured at out[i+1]
 *   back: [destination, ...routeBack, us]     snrBack[i]    measured at back[i+1]
 *
 * (`toNodeNum` is the requester — us; `fromNodeNum` is the responder.)
 *
 * The leg next to our radio is the first hop out and the last hop back. When
 * both name the SAME neighbour — for a zero-hop run, the destination itself —
 * that one RF link carried a packet each way: the neighbour heard us
 * (`snrTowards[0]`) and we heard the neighbour (the last `snrBack` entry).
 * That is a confirmed reciprocal link. A run that went out through one
 * neighbour and came back through another confirms neither.
 *
 * Only that one leg is used. Hops further out are other radios' links; this
 * layer is about what our own radio can reach and be reached by.
 *
 * ## Transport
 *
 * `traceroutes.transportMechanism` is ONE value per row: how the packet that
 * delivered the reply reached us. That is exactly the "back" half of this
 * link, so it is the link's class — unless either hop carries the firmware's
 * unknown-SNR sentinel, which the rest of the map already reads as MQTT
 * (`hopTransportClass`, #5097). The same link confirmed over RF by one run
 * and over MQTT by another yields two rows, one per class.
 *
 * ## Limits
 *
 * Computed on read; nothing is stored. MeshMonitor keeps only
 * `TRACEROUTE_HISTORY_LIMIT` runs per node pair, so counts are capped by that
 * and an old confirmation can age out however long the window is.
 *
 * Mesh impact: none. Read-only; it sends no traceroute and no packet.
 */
import { tracerouteTransportClass, hopTransportClass, type NodeTransportClass } from '../../utils/tracerouteTransport.js';
import {
  hasReturnPath, hasRouteData, isUnknownSnr, isValidRouteNode, parseHopArray,
} from '../../utils/tracerouteSegments.js';

/** The traceroute columns this module reads. Node numbers may be BIGINT strings. */
export interface ConfirmedLinkTracerouteRow {
  sourceId: string;
  fromNodeNum: number | string;
  toNodeNum: number | string;
  route: string | null | undefined;
  routeBack: string | null | undefined;
  snrTowards: string | null | undefined;
  snrBack: string | null | undefined;
  transportMechanism?: number | null;
  timestamp: number;
}

/** One traceroute's evidence for one reciprocal link. */
export interface ConfirmedLinkObservation {
  sourceId: string;
  localNodeNum: number;
  neighborNodeNum: number;
  transportClass: NodeTransportClass;
  /** True when the neighbour was the destination (no intermediate hop). */
  direct: boolean;
  /** dB at the neighbour, hearing us. Null when the run has no real sample. */
  snrOutDb: number | null;
  /** dB at us, hearing the neighbour. Null when the run has no real sample. */
  snrBackDb: number | null;
  timestamp: number;
}

/** Raw (x4) firmware SNR -> dB, plus whether it was the unknown-SNR sentinel. */
function readSnr(raw: number | undefined): { db: number | null; unknown: boolean } {
  if (raw === undefined || !Number.isFinite(raw)) return { db: null, unknown: false };
  const scaled = raw / 4;
  if (isUnknownSnr(scaled)) return { db: null, unknown: true };
  return { db: scaled, unknown: false };
}

/**
 * The reciprocal link one traceroute confirms, or null.
 *
 * Null when: the run was not requested by `localNodeNum`; it has no outbound
 * route data or no recorded return path (not completed); the neighbour on the
 * way out differs from the one on the way back; or that neighbour is a
 * firmware placeholder rather than a real node.
 */
export function confirmedLinkFromTraceroute(
  row: ConfirmedLinkTracerouteRow,
  localNodeNum: number,
): ConfirmedLinkObservation | null {
  const requester = Number(row.toNodeNum);
  const responder = Number(row.fromNodeNum);
  if (!Number.isFinite(requester) || !Number.isFinite(responder)) return null;
  if (requester !== localNodeNum || responder === requester) return null;

  if (!hasRouteData(row.route)) return null;
  const route = parseHopArray(row.route);
  const routeBack = parseHopArray(row.routeBack);
  if (!hasReturnPath(routeBack, row.snrBack)) return null;

  const firstOut = route.length > 0 ? route[0] : responder;
  const lastBack = routeBack.length > 0 ? routeBack[routeBack.length - 1] : responder;
  if (firstOut !== lastBack) return null;
  if (firstOut === requester) return null;
  // An intermediate hop can be a placeholder (a relay that never named
  // itself). The responder is a real node number by construction.
  if (firstOut !== responder && !isValidRouteNode(firstOut)) return null;

  const out = readSnr(parseHopArray(row.snrTowards)[0]);
  const back = readSnr(parseHopArray(row.snrBack)[routeBack.length]);

  return {
    sourceId: row.sourceId,
    localNodeNum,
    neighborNodeNum: firstOut,
    transportClass: hopTransportClass(tracerouteTransportClass(row), out.unknown || back.unknown),
    direct: firstOut === responder,
    snrOutDb: out.db,
    snrBackDb: back.db,
    timestamp: row.timestamp,
  };
}

/** Observations folded into one row per (source, neighbour, transport class). */
export interface ConfirmedLinkAggregate {
  sourceId: string;
  localNodeNum: number;
  neighborNodeNum: number;
  transportClass: NodeTransportClass;
  /** Completed traceroutes that confirmed this link. */
  count: number;
  /** Of those, runs where the neighbour was the destination itself. */
  directCount: number;
  snrOutAvg: number | null;
  snrOutSamples: number;
  snrBackAvg: number | null;
  snrBackSamples: number;
  lastConfirmedAt: number;
}

export function aggregateConfirmedLinks(observations: ConfirmedLinkObservation[]): ConfirmedLinkAggregate[] {
  interface Acc extends ConfirmedLinkAggregate { outSum: number; backSum: number }
  const map = new Map<string, Acc>();
  for (const o of observations) {
    const key = `${o.sourceId}|${o.neighborNodeNum}|${o.transportClass}`;
    let a = map.get(key);
    if (!a) {
      a = {
        sourceId: o.sourceId, localNodeNum: o.localNodeNum, neighborNodeNum: o.neighborNodeNum,
        transportClass: o.transportClass, count: 0, directCount: 0,
        snrOutAvg: null, snrOutSamples: 0, snrBackAvg: null, snrBackSamples: 0,
        lastConfirmedAt: 0, outSum: 0, backSum: 0,
      };
      map.set(key, a);
    }
    a.count += 1;
    if (o.direct) a.directCount += 1;
    if (o.snrOutDb !== null) { a.outSum += o.snrOutDb; a.snrOutSamples += 1; }
    if (o.snrBackDb !== null) { a.backSum += o.snrBackDb; a.snrBackSamples += 1; }
    if (o.timestamp > a.lastConfirmedAt) a.lastConfirmedAt = o.timestamp;
  }
  return Array.from(map.values()).map(({ outSum, backSum, ...a }) => ({
    ...a,
    snrOutAvg: a.snrOutSamples > 0 ? outSum / a.snrOutSamples : null,
    snrBackAvg: a.snrBackSamples > 0 ? backSum / a.snrBackSamples : null,
  }));
}

/**
 * Rows -> aggregated confirmed links. `localNodeNums` maps a source to its
 * own radio's node number; a row from a source with no entry (an MQTT source,
 * one that never connected) is skipped — it has no "our radio" to anchor on.
 */
export function buildConfirmedLinks(
  rows: ConfirmedLinkTracerouteRow[],
  localNodeNums: Map<string, number>,
): ConfirmedLinkAggregate[] {
  const observations: ConfirmedLinkObservation[] = [];
  for (const row of rows) {
    const local = localNodeNums.get(row.sourceId);
    if (local === undefined) continue;
    const obs = confirmedLinkFromTraceroute(row, local);
    if (obs) observations.push(obs);
  }
  return aggregateConfirmedLinks(observations);
}
