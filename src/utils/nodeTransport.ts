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

/** Classify a node's most-recent transport for the map filter. */
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
 * Returns true when a node should be visible on the map given the
 * three transport-class toggles. Keep this small/inlined — it's
 * called from inside large `.filter()` chains.
 */
export function nodePassesTransportFilter(
  node: { transportMechanism?: number | null; viaMqtt?: boolean | null },
  flags: { showRfNodes: boolean; showUdpNodes: boolean; showMqttNodes: boolean },
): boolean {
  switch (classifyNodeTransport(node)) {
    case 'mqtt': return flags.showMqttNodes;
    case 'udp':  return flags.showUdpNodes;
    case 'rf':   return flags.showRfNodes;
  }
}
