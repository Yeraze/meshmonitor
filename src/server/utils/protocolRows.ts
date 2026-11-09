/**
 * Pure row mappers that put MeshCore rows into the shape the v1 API (and the
 * metrics collector) already use for Meshtastic rows (#6263 S2).
 *
 * One shared shape, one `protocol` discriminator. Identity rules:
 *  - `nodeId` / `nodeKey` for MeshCore is `mc:<publicKey>` (lowercase); the
 *    synthetic `nodeNum` (`nodeNumFromPubkey`) is carried for clients that need
 *    a number, but joins MUST use `nodeKey` / `publicKey`, never `nodeNum`.
 *  - A key that is not a full 64-hex public key (a DM prefix, a `channel-N`
 *    pseudo key) gets no `publicKey` and no `nodeNum`.
 *
 * Units follow the Meshtastic v1 rows: node `lastHeard` in SECONDS (MeshCore
 * stores ms), message/packet/trace timestamps in ms, trace SNR arrays in the
 * Meshtastic dB*4 integer unit (MeshCore hop rows already store quarter-dB).
 */
import type { DbMeshCoreNode, DbMeshCoreMessage, DbMeshCorePacket } from '../../db/repositories/meshcore.js';
import type { MeshCoreHopSnrRow } from '../../db/repositories/meshcoreHopSnr.js';
import { nodeNumFromPubkey } from '../../utils/meshcoreNodeNum.js';
import { buildMeshCoreTraceRun } from '../../utils/meshcoreTraceRun.js';
import { unifiedNodeKey } from '../../utils/nodeIdentity.js';
import { meshcoreChannelIdx } from './meshcoreChannelIdx.js';

export type Protocol = 'meshtastic' | 'meshcore';

/** Meshtastic's broadcast node number / id. */
export const BROADCAST_NODE_NUM = 0xffffffff;
export const BROADCAST_NODE_ID = '!ffffffff';
/** `route` entry for a trace hop whose node could not be resolved to a contact. */
export const UNRESOLVED_NODE_NUM = 4294967295;

const FULL_KEY_RE = /^[0-9a-fA-F]{64}$/;

/** Add `protocol: 'meshtastic'` to a Meshtastic row. */
export function withMeshtasticProtocol<T extends object>(row: T): T & { protocol: 'meshtastic' } {
  return { ...row, protocol: 'meshtastic' as const };
}

/** `mc:<pk>` identity for a MeshCore key (full or prefix), lowercase; null when empty. */
export function meshcoreNodeKey(publicKey: string | null | undefined): string | null {
  if (!publicKey) return null;
  return unifiedNodeKey({ isMeshCore: true, publicKey: publicKey.toLowerCase() });
}

/** Accepts `mc:<pk>` or a bare 64-hex key; returns the lowercase key, or null. */
export function parseMeshcoreNodeId(id: unknown): string | null {
  // Query/body values can arrive as arrays or objects; only a string can be a key.
  if (typeof id !== 'string' || !id) return null;
  const bare = id.startsWith('mc:') ? id.slice(3) : id;
  return FULL_KEY_RE.test(bare) ? bare.toLowerCase() : null;
}

interface KeyFields {
  nodeId: string | null;
  nodeNum: number | null;
  publicKey: string | null;
}

function keyFields(key: string | null | undefined): KeyFields {
  const nodeId = meshcoreNodeKey(key);
  const full = !!key && FULL_KEY_RE.test(key);
  return {
    nodeId,
    nodeNum: full ? nodeNumFromPubkey(key!) : null,
    publicKey: full ? key!.toLowerCase() : null,
  };
}

// ---------------------------------------------------------------- nodes

export function meshcoreNodeToV1(row: DbMeshCoreNode, sourceId?: string | null) {
  const k = keyFields(row.publicKey);
  const lastHeardSec = typeof row.lastHeard === 'number' ? Math.floor(row.lastHeard / 1000) : null;
  const firstHeardSec = typeof row.firstHeard === 'number' ? Math.floor(row.firstHeard / 1000) : null;
  return {
    protocol: 'meshcore' as const,
    nodeId: k.nodeId,
    nodeKey: k.nodeId,
    publicKey: k.publicKey,
    nodeNum: k.nodeNum,
    longName: row.name ?? null,
    shortName: row.name ? row.name.slice(0, 4) : null,
    advType: row.advType ?? null,
    hopsAway: row.pathLen ?? null,
    lastHeard: lastHeardSec,
    firstHeard: firstHeardSec,
    snr: row.snr ?? null,
    rssi: row.rssi ?? null,
    latitude: row.latitude ?? null,
    longitude: row.longitude ?? null,
    altitude: row.altitude ?? null,
    voltage: typeof row.batteryMv === 'number' ? row.batteryMv / 1000 : null,
    uptimeSeconds: row.uptimeSecs ?? null,
    isFavorite: !!row.isFavorite,
    isLocalNode: !!row.isLocalNode,
    sourceId: row.sourceId ?? sourceId ?? null,
  };
}

// ------------------------------------------------------------- messages

export function meshcoreMessageToV1(row: DbMeshCoreMessage, sourceId?: string | null) {
  const chIdx = meshcoreChannelIdx(row);
  const isChannel = chIdx !== null;
  // A channel message has no resolvable sender key (`channel-N` pseudo key);
  // the name parsed from the body is the only attribution.
  const from = isChannel ? { nodeId: null, nodeNum: null, publicKey: null } : keyFields(row.fromPublicKey);
  const to = isChannel
    ? { nodeId: BROADCAST_NODE_ID, nodeNum: BROADCAST_NODE_NUM, publicKey: null }
    : keyFields(row.toPublicKey);
  return {
    protocol: 'meshcore' as const,
    id: row.id,
    fromNodeId: from.nodeId,
    fromNodeNum: from.nodeNum,
    fromPublicKey: from.publicKey,
    fromName: row.fromName ?? null,
    toNodeId: to.nodeId,
    toNodeNum: to.nodeNum,
    toPublicKey: to.publicKey,
    text: row.text,
    channel: isChannel ? chIdx : -1,
    messageType: row.messageType ?? (isChannel ? 'channel' : 'dm'),
    timestamp: row.timestamp,
    rxSnr: row.snr ?? null,
    rxRssi: row.rssi ?? null,
    hopCount: row.hopCount ?? null,
    routePath: row.routePath ?? null,
    delivered: row.delivered ?? null,
    deliveredAt: row.deliveredAt ?? null,
    createdAt: row.createdAt,
    sourceId: row.sourceId ?? sourceId ?? null,
  };
}

// ----------------------------------------------------------- traceroute

export interface MeshcoreTraceOptions {
  /** The source's own key, used for an unresolved first sender (the requester). */
  localPublicKey?: string | null;
  /** The contact the trace was sent to, when known (splits the round trip there). */
  targetPublicKey?: string | null;
}

/**
 * Map the hop rows of ONE trace (any order) to a v1 traceroute row, through the
 * shared run builder (`buildMeshCoreTraceRun`, also used by the Explorer).
 *
 * A stored trace is a loop local -> hops -> local. `fromNode*` is the local
 * radio; `toNode*` is the turnaround (or the target when the caller knows it).
 * `route` / `snrTowards` are the outbound leg, `routeBack` / `snrBack` the
 * return leg (null when the return link was not recorded). Synthetic numbers
 * are display only; `UNRESOLVED_NODE_NUM` marks a hop that did not resolve.
 * Returns null for an empty trace.
 */
export function meshcoreTraceToV1(rows: MeshCoreHopSnrRow[], opts: MeshcoreTraceOptions = {}) {
  const run = buildMeshCoreTraceRun(rows, {
    localPublicKey: opts.localPublicKey ?? null,
    targetPublicKey: opts.targetPublicKey ?? null,
  });
  if (!run) return null;
  const hops = [...rows].sort((a, b) => a.hopIndex - b.hopIndex);
  const first = hops[0];
  const idOf = (key: string): string | null => (key.startsWith('mc:') ? key : null);
  return {
    protocol: 'meshcore' as const,
    fromNodeId: idOf(run.fromKey),
    fromNodeNum: run.fromNodeNum,
    toNodeId: idOf(run.toKey),
    toNodeNum: run.toNodeNum,
    route: run.route,
    routeBack: run.routeBack,
    snrTowards: run.snrTowards,
    snrBack: run.snrBack,
    channel: null,
    hops: hops.map((h) => ({
      index: h.hopIndex,
      publicKey: h.receiverPublicKey ? h.receiverPublicKey.toLowerCase() : null,
      hash: h.receiverHash ?? null,
      snr: h.snrQuarterDb / 4,
    })),
    initiated: run.initiated,
    traceTag: first.traceTag,
    timestamp: first.timestamp,
    sourceId: first.sourceId,
  };
}

// -------------------------------------------------------------- packets

export interface MeshcorePacketOptions {
  /** Decoded plaintext, only when the viewer may read it. Omitted otherwise. */
  plaintext?: string | null;
}

export function meshcorePacketToV1(row: DbMeshCorePacket, opts: MeshcorePacketOptions = {}) {
  const k = keyFields(row.senderPubKey);
  return {
    protocol: 'meshcore' as const,
    id: row.id ?? null,
    timestamp: row.timestamp,
    payload_type: row.payloadType,
    payload_type_name: row.payloadTypeName ?? null,
    route_type: row.routeType ?? null,
    route_type_name: row.routeTypeName ?? null,
    hop_count: row.hopCount ?? null,
    path_hops: row.pathHops ? row.pathHops.split(',').filter(Boolean) : [],
    snr: row.snr ?? null,
    rssi: row.rssi ?? null,
    payload_size: row.payloadSize ?? null,
    raw_hex: row.rawHex ?? null,
    observer_id: row.observerId ?? null,
    src_hash: row.srcHash ?? null,
    sender_public_key: k.publicKey,
    node_key: k.nodeId,
    from_node: k.nodeNum,
    advert_name: row.advertName ?? null,
    ...(opts.plaintext !== undefined ? { plaintext: opts.plaintext } : {}),
    sourceId: row.sourceId ?? null,
  };
}
