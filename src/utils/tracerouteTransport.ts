/**
 * Transport classification for rendered traceroute hops (#5097).
 *
 * The map's Show RF / Show UDP / Show MQTT toggles filtered node markers
 * (`nodePassesTransportFilter`) and neighbor links (#3223), but route segments
 * rendered regardless. NullVoid's ask: "have route segments respect the mqtt
 * and udp flag — if either of these are off, route segments that relied on
 * mqtt or udp are filtered from the map."
 *
 * ## What the data actually supports
 *
 * There are exactly two transport signals on a traceroute, at different
 * granularities:
 *
 *   - **Per-record** — `traceroutes.transportMechanism` (migration 160): the
 *     `MeshPacket.TransportMechanism` of the packet that carried the route
 *     data to us. NULL on pre-migration rows, which `classifyNodeTransport`
 *     resolves to `'rf'` so historical traceroutes stay visible by default.
 *
 *   - **Per-hop** — the firmware's unknown-SNR sentinel (`isMqtt` on a
 *     `TracerouteRenderSegment`, #2931). It says nothing whatsoever about UDP,
 *     and it is not *only* an MQTT marker: `TraceRouteModule::insertUnknownHops`
 *     writes it for an MQTT-bridged leg, a decrypt failure, a relay-role node,
 *     or pre-snr-array firmware alike. Treating it as MQTT is nonetheless the
 *     right call here, for two reasons. It is what the map already tells the
 *     user — these hops render in the MQTT colour and dash style today — and
 *     under the reading the request came from ("show me what the RF mesh alone
 *     can show me"), a hop whose SNR the firmware could not fill in is not an
 *     RF-confirmed hop either way.
 *
 * The traceroute protobuf carries no per-hop transport field, so there is no
 * third option and no way to recover UDP at hop granularity. Hence:
 *
 *   hop class = sentinel ? 'mqtt' : the record's own transport class
 *
 * The sentinel WINS over the record. That ordering is the requester's ask: a
 * hop that relied on MQTT drops out when Show MQTT is off, even though the
 * traceroute reporting it reached us over RF. Treating the two as additive
 * would keep exactly the segments the toggle is meant to remove.
 *
 * ## Across records
 *
 * The aggregated layer ("Show Route Segments") collapses many traceroutes onto
 * one line per node pair, so a segment can carry several hop classes. There
 * the union IS additive, matching `nodePassesTransportFilter`: a link observed
 * over RF by one traceroute and over MQTT by another stays on the map while
 * Show RF is on, because the RF observation is real evidence for that link.
 * Additive-across-records and sentinel-wins-within-a-hop are not in tension —
 * they answer different questions ("was this link ever seen over RF?" vs
 * "did this particular hop rely on MQTT?").
 *
 * For single-record layers (the selected traceroute, the Dashboard's per-record
 * segments) the union has one member and this collapses to the same rule the
 * neighbor links use.
 */
import { classifyNodeTransport, TX_MQTT, type NodeTransportClass } from './nodeTransport.js';
import { decomposeTracerouteLinks, isUnknownSnr } from './tracerouteSegments.js';

export type { NodeTransportClass };

/** The transport toggles, as the map contexts spell them. */
export interface TransportFilterFlags {
  showRfNodes: boolean;
  showUdpNodes: boolean;
  showMqttNodes: boolean;
}

/** The subset of a traceroute row this module reads. */
export interface TracerouteTransportFields {
  transportMechanism?: number | null;
  /** Legacy fallback, for rows/digests that carry the boolean but not the enum. */
  viaMqtt?: boolean | null;
}

/**
 * Transport class of the traceroute record itself — how the route data reached
 * us. NULL/absent `transportMechanism` resolves to `'rf'` (see module doc).
 */
export function tracerouteTransportClass(
  traceroute: TracerouteTransportFields | null | undefined,
): NodeTransportClass {
  return classifyNodeTransport({
    transportMechanism: traceroute?.transportMechanism,
    viaMqtt: traceroute?.viaMqtt,
  });
}

/**
 * Transport class of one rendered hop. The per-hop MQTT sentinel overrides the
 * record's own transport — see the module doc for why that ordering is the
 * whole point.
 */
export function hopTransportClass(
  recordClass: NodeTransportClass,
  hopIsMqtt: boolean,
): NodeTransportClass {
  return hopIsMqtt ? 'mqtt' : recordClass;
}

/**
 * Whether a segment should be drawn, given every transport class observed for
 * it. Additive across classes, like `nodePassesTransportFilter`.
 *
 * An empty class set returns `true` rather than `false`: a segment with no
 * transport evidence at all is not a segment the user asked to hide, and
 * returning false would make it invisible under every combination of toggles.
 */
export function segmentPassesTransportFilter(
  classes: Iterable<NodeTransportClass>,
  flags: TransportFilterFlags,
): boolean {
  let sawAny = false;
  for (const c of classes) {
    sawAny = true;
    switch (c) {
      case 'mqtt': if (flags.showMqttNodes) return true; break;
      case 'udp':  if (flags.showUdpNodes) return true; break;
      case 'rf':   if (flags.showRfNodes) return true; break;
    }
  }
  return !sawAny;
}

/**
 * True when the toggles are all on — i.e. the filter cannot remove anything.
 * Callers use this to skip the per-segment work entirely, which is the common
 * case on a map with hundreds of segments.
 */
export function transportFilterIsInert(flags: TransportFilterFlags): boolean {
  return flags.showRfNodes && flags.showUdpNodes && flags.showMqttNodes;
}

/** The subset of a traceroute row `reachTransportClass` needs (#5101). */
export interface ReachTransportInput extends TracerouteTransportFields {
  fromNodeNum: number;
  toNodeNum: number;
  route: string | null | undefined;
  snrTowards: string | null | undefined;
}

/**
 * One transport class for a whole answered route, for reach-by-hop-count
 * (#5101). The FORWARD leg is what `hops` counts (route.length), so only its
 * hops are consulted. Any forward hop carrying the unknown-SNR sentinel makes
 * the route 'mqtt' — the same sentinel-wins rule as `hopTransportClass`, so a
 * peer counts as RF-reachable only if every hop to it was RF-confirmed.
 * Otherwise the record's own class (NULL → 'rf'). Return-leg sentinels are
 * ignored, since `hops` does not count that leg.
 */
export function reachTransportClass(tr: ReachTransportInput): NodeTransportClass {
  const forwardUnknown = decomposeTracerouteLinks({
    fromNodeNum: tr.fromNodeNum, toNodeNum: tr.toNodeNum,
    route: tr.route, snrTowards: tr.snrTowards,
  }).some((l) => l.leg === 'forward' && l.snrUnknown);
  return hopTransportClass(tracerouteTransportClass(tr), forwardUnknown);
}

/**
 * The `transportMechanism` to store on one `route_segments` row (#5101).
 * `rawArrivalSnr` is the RAW (x4) firmware value recorded at the hop's far
 * end — `snrTowards[i]` for segment `i` of `[requester, ...route, responder]`
 * (or the equivalent index-aligned position in the MQTT writer's forward/
 * return legs). Sentinel wins (see module doc): a hop whose arrival SNR is
 * the unknown-SNR sentinel is stored as MQTT (5) regardless of the record's
 * own mechanism. Otherwise the record's own mechanism is stored as-is, NULL
 * passed through unchanged (reads as RF via `classifyNodeTransport`).
 */
export function segmentTransportMechanism(
  recordMechanism: number | null | undefined,
  rawArrivalSnr: number | undefined,
): number | null {
  const scaledSnr = rawArrivalSnr === undefined ? undefined : rawArrivalSnr / 4;
  if (scaledSnr !== undefined && isUnknownSnr(scaledSnr)) return TX_MQTT;
  return recordMechanism ?? null;
}
