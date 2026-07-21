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
   * Unix seconds when this node was last heard over each transport (migration
   * 126, #4240). NULL/absent = never seen that way.
   *
   * Replaces relying on the last-wins `transportMechanism`, which a local node
   * with an MQTT uplink overwrites constantly — it receives echoes of its own
   * RF traffic flagged `viaMqtt`, so the single column thrashes and the node
   * vanishes behind the default-off "Show MQTT" toggle.
   *
   * Timestamps rather than sticky booleans give both the OR across transports
   * and natural decay: a transport counts as current only while its stamp is
   * inside the caller's active window, so a node that stops being heard over
   * RF stops being an RF node on its own — no sweep job required.
   */
  transportLastRf?: number | null;
  transportLastMqtt?: number | null;
  transportLastUdp?: number | null;
  /**
   * Union of transport classes this node has been observed on, across every
   * source that reported it. Present on Unified-merged nodes so the map's
   * RF/UDP/MQTT toggles are *additive* — a node heard via RF on one source and
   * MQTT on another stays visible while "Show RF" is on even if "Show MQTT" is
   * off. Absent on single-source rows.
   */
  transportClasses?: NodeTransportClass[] | null;
}

/**
 * The staleness cutoff (unix seconds) for transport decay, from the user's
 * active window. Compute ONCE per render and pass it down — calling this
 * inside a `.filter()` predicate would re-read the clock per node.
 */
export function transportCutoffSec(maxAgeHours: number, nowMs: number = Date.now()): number {
  return nowMs / 1000 - maxAgeHours * 60 * 60;
}

/** Column recording "last heard over this transport" for each class. */
export const TRANSPORT_LAST_COLUMN = {
  rf: 'transportLastRf',
  mqtt: 'transportLastMqtt',
  udp: 'transportLastUdp',
} as const;

export type TransportLastColumn =
  (typeof TRANSPORT_LAST_COLUMN)[keyof typeof TRANSPORT_LAST_COLUMN];

/**
 * Which per-transport column a freshly received packet should stamp. Mirrors
 * `classifyNodeTransport`, including its viaMqtt fallback for
 * INTERNAL / API / unknown mechanisms.
 */
export function transportColumnForPacket(
  mechanism: number | null | undefined,
  viaMqtt?: boolean | null,
): TransportLastColumn {
  return TRANSPORT_LAST_COLUMN[
    classifyNodeTransport({ transportMechanism: mechanism, viaMqtt })
  ];
}

/** The (class, timestamp) pairs this node actually has evidence for. */
function transportStamps(node: NodeTransportFields): Array<[NodeTransportClass, number]> {
  const out: Array<[NodeTransportClass, number]> = [];
  if (typeof node.transportLastRf === 'number') out.push(['rf', node.transportLastRf]);
  if (typeof node.transportLastMqtt === 'number') out.push(['mqtt', node.transportLastMqtt]);
  if (typeof node.transportLastUdp === 'number') out.push(['udp', node.transportLastUdp]);
  return out;
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
export function getNodeTransportClasses(
  node: NodeTransportFields,
  cutoffSec?: number,
): NodeTransportClass[] {
  // #4240: per-transport timestamps are the most precise signal — they survive
  // MQTT echoes and they decay. Checked before the precomputed union so the
  // active window actually applies to Unified nodes too.
  const stamps = transportStamps(node);
  if (stamps.length > 0) {
    if (typeof cutoffSec === 'number') {
      const fresh = stamps.filter(([, ts]) => ts >= cutoffSec).map(([c]) => c);
      if (fresh.length > 0) return fresh;
      // Every transport has aged out. Fall through to the most recent one
      // rather than returning [] — a node with NO class is invisible under
      // every toggle, which would silently hide favorites (they deliberately
      // bypass the staleness gate) and anything surfaced by a longer-window
      // view. Decay decides WHICH transport is current, never whether the node
      // exists.
      const newest = Math.max(...stamps.map(([, ts]) => ts));
      return stamps.filter(([, ts]) => ts === newest).map(([c]) => c);
    }
    // No window supplied: union everything we have evidence for.
    return stamps.map(([c]) => c);
  }

  // Cross-source union precomputed by the Unified merge, for records that
  // carry no timestamps of their own.
  if (Array.isArray(node.transportClasses) && node.transportClasses.length > 0) {
    return node.transportClasses;
  }

  // Pre-migration-126 rows (or rows whose lastHeard was NULL at backfill).
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
  /**
   * Unix seconds. Transports last heard before this are treated as stale and
   * stop counting (#4240) — normally `now - maxNodeAgeHours`. Omit to disable
   * decay and match on every transport the node has ever been heard over.
   */
  cutoffSec?: number,
): boolean {
  return getNodeTransportClasses(node, cutoffSec).some((c) => {
    switch (c) {
      case 'mqtt': return flags.showMqttNodes;
      case 'udp':  return flags.showUdpNodes;
      case 'rf':   return flags.showRfNodes;
    }
  });
}
