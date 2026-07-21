/**
 * Frontend classification of a node's transport mechanism for the map's
 * Show RF / UDP / MQTT visibility toggles (#3112).
 *
 * Mirrors `meshtastic.MeshPacket.TransportMechanism`:
 *   0 INTERNAL · 1 LORA · 2-4 LORA_ALT* · 5 MQTT · 6 MULTICAST_UDP · 7 API
 *
 * The backend stamps `transportMechanism` onto the node row from every
 * heard packet (most-recent wins). Migration 066 backfills the column
 * from `viaMqtt`. For rows that somehow lack both fields we fall back
 * to RF, matching the default map behaviour.
 */

export const TX_INTERNAL = 0;
export const TX_LORA = 1;
export const TX_LORA_ALT1 = 2;
export const TX_LORA_ALT2 = 3;
export const TX_LORA_ALT3 = 4;
export const TX_MQTT = 5;
export const TX_MULTICAST_UDP = 6;
export const TX_API = 7;

export type NodeTransportClass = 'rf' | 'udp' | 'mqtt';

/** A node carrying a precomputed union of transport classes (set by the
 *  Unified merge — see `mergeUnifiedSourceData`). */
export interface NodeTransportFields {
  transportMechanism?: number | null;
  viaMqtt?: boolean | null;
  /**
   * Accumulating bitmask of every transport this node has been heard over
   * (migration 126, #4240). Persisted per node row and ORed on write, so it
   * expresses "reachable over RF *and* MQTT" — which the last-wins
   * `transportMechanism` cannot.
   *
   * This matters because a local node with an MQTT uplink receives echoes of
   * the same RF traffic flagged `viaMqtt`. Under last-wins those echoes
   * overwrite the RF classification, and the node vanishes behind the
   * default-off "Show MQTT" toggle.
   */
  transportFlags?: number | null;
  /**
   * Union of transport classes this node has been observed on, across every
   * source that reported it. Present on Unified-merged nodes so the map's
   * RF/UDP/MQTT toggles are *additive* — a node heard via RF on one source and
   * MQTT on another stays visible while "Show RF" is on even if "Show MQTT" is
   * off. Absent on single-source rows.
   */
  transportClasses?: NodeTransportClass[] | null;
}

/** Transport bits persisted in `nodes.transportFlags` (migration 126). */
export const TF_RF = 1;
export const TF_MQTT = 2;
export const TF_UDP = 4;

/** Map a wire transport mechanism (+ legacy viaMqtt) onto its single bit. */
export function transportBitFor(
  mechanism: number | null | undefined,
  viaMqtt?: boolean | null,
): number {
  if (mechanism === TX_MQTT) return TF_MQTT;
  if (mechanism === TX_MULTICAST_UDP) return TF_UDP;
  if (
    mechanism === TX_LORA || mechanism === TX_LORA_ALT1 ||
    mechanism === TX_LORA_ALT2 || mechanism === TX_LORA_ALT3
  ) {
    return TF_RF;
  }
  // INTERNAL / API / unknown: honor the legacy boolean, else treat as RF —
  // identical to classifyNodeTransport's fallback.
  return viaMqtt ? TF_MQTT : TF_RF;
}

/** Expand a persisted bitmask into map filter classes. */
export function transportClassesFromFlags(flags: number): NodeTransportClass[] {
  const classes: NodeTransportClass[] = [];
  if (flags & TF_RF) classes.push('rf');
  if (flags & TF_UDP) classes.push('udp');
  if (flags & TF_MQTT) classes.push('mqtt');
  return classes;
}

/** Classify a single node record's most-recent transport for the map filter. */
export function classifyNodeTransport(node: {
  transportMechanism?: number | null;
  viaMqtt?: boolean | null;
}): NodeTransportClass {
  const tx = node.transportMechanism;
  if (tx === TX_MQTT) return 'mqtt';
  if (tx === TX_MULTICAST_UDP) return 'udp';
  if (tx === TX_LORA || tx === TX_LORA_ALT1 || tx === TX_LORA_ALT2 || tx === TX_LORA_ALT3) {
    return 'rf';
  }
  // INTERNAL / API / null fall through. Honor the legacy viaMqtt boolean
  // when the new column is missing (e.g. a stub row inserted before
  // migration 066 ran on an upgraded deployment).
  if (node.viaMqtt) return 'mqtt';
  return 'rf';
}

/**
 * The set of transport classes a node should be filtered against. Prefers the
 * precomputed `transportClasses` union (Unified view), falling back to the
 * single classification of this record (single-source view / unmerged rows).
 */
export function getNodeTransportClasses(node: NodeTransportFields): NodeTransportClass[] {
  // Cross-source union (Unified merge) is the broadest signal, so it wins.
  if (Array.isArray(node.transportClasses) && node.transportClasses.length > 0) {
    return node.transportClasses;
  }
  // #4240: the per-node accumulating bitmask. Preferred over the last-wins
  // single value, which an MQTT echo can overwrite.
  const flags = node.transportFlags;
  if (typeof flags === 'number' && flags > 0) {
    return transportClassesFromFlags(flags);
  }
  // Pre-migration-126 rows, or a row whose flags haven't been written yet.
  return [classifyNodeTransport(node)];
}

/**
 * Returns true when a node should be visible on the map given the three
 * transport-class toggles. Additive: a node is shown when ANY transport class
 * it has been seen on (across sources) has its toggle enabled — so toggling
 * MQTT off no longer hides a node that is also reachable via RF. Keep this
 * small — it's called from inside large `.filter()` chains.
 */
export function nodePassesTransportFilter(
  node: NodeTransportFields,
  flags: { showRfNodes: boolean; showUdpNodes: boolean; showMqttNodes: boolean },
): boolean {
  return getNodeTransportClasses(node).some((c) => {
    switch (c) {
      case 'mqtt': return flags.showMqttNodes;
      case 'udp':  return flags.showUdpNodes;
      case 'rf':   return flags.showRfNodes;
    }
  });
}
