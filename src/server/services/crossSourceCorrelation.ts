/**
 * Cross-source correlation (#5559 / #5560 / #5561, Phase 0 foundation).
 *
 * In a multi-source install, one of our sources (A) can be heard by another
 * of our sources (B). B's RX row then tells us something A's own log cannot:
 * that A actually put that packet on the air, and that B was in range. This
 * module is the ONE place that answers "is this reception from, or relayed
 * by, one of our other sources?" Every consumer (Unified Packet Monitor,
 * Coverage Report, map edges) goes through it.
 *
 * Three parts:
 *  1. {@link resolveCrossSourceIndex}: identity resolver. Given the source ids
 *     a viewer may read, it loads each source's own identity: the persisted
 *     Meshtastic local nodeNum (works while disconnected) and the persisted
 *     MeshCore local public key (`isLocalNode`). Live manager values fill any
 *     gap (a source that connected but has not persisted yet).
 *  2. Pure classifiers ({@link classifyMeshtasticReception},
 *     {@link classifyMeshCoreReception}): origin / likely relay / none, plus
 *     the transport class that carried the copy (rf | mqtt_gateway | mqtt |
 *     udp).
 *  3. The permission rule, applied by construction: the index only ever holds
 *     sources the viewer can read, and the row being classified is itself
 *     from a readable source. So a tag can only ever name a source the
 *     viewer can read, and a viewer who can read just one source never learns
 *     that "another source" exists. {@link resolveCorrelationSourceIds} is the
 *     shared gate every consumer uses to build the index.
 *
 * Origin vs relay:
 *  - Meshtastic origin: `from_node` is A's nodeNum. Proven (the firmware only
 *    stamps its own nodeNum on packets it originates).
 *  - Meshtastic relay: `relay_node` (8-bit, the low byte of the last relayer)
 *    equals the low byte of A's nodeNum, the packet is not from A, and it
 *    has taken at least one hop. One byte is ambiguous across a busy mesh, so
 *    this is always labelled "likely" (inferred); every matching source is
 *    returned as a candidate.
 *  - MeshCore origin: an ADVERT whose public key is A's key. The caller
 *    verifies the advert signature before treating it as proof.
 *  - MeshCore relay: a FLOOD packet whose path holds a relay hash that is a
 *    prefix of A's public key. Also "likely" (1-3 byte hashes collide).
 *  - A companion cannot see its own outbound frame, so a MeshCore packet-hash
 *    match only proves two sources heard the same packet, never who sent it.
 *    It is deliberately not used here.
 *
 * Exclusions: a candidate is never the receiving source itself, and never a
 * source with the SAME identity as the receiving source (two connections to
 * one physical radio would otherwise "hear each other"). A gateway/observer
 * row whose reporting node IS the candidate is skipped (A reporting its own
 * packet is not a cross-source hearing).
 *
 * Mesh impact: none. Read-only; no packets, no timers, nothing on
 * `dataEventEmitter`.
 */
import type { Request } from 'express';
import databaseService from '../../services/database.js';
import { resolveLocalNodeNums } from '../utils/localNodeNums.js';
import { resolvePermittedSourceIds } from '../utils/permittedSources.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { isMeshCoreManager, isMeshtasticManager } from '../sourceManagerTypes.js';
import { TransportMechanism } from '../constants/meshtastic.js';
import { logger } from '../../utils/logger.js';
import { decodeMeshCorePacket } from '../../utils/meshcorePacketDecode.js';
import { MESHCORE_PAYLOAD_ADVERT } from '../../utils/coverage.js';
import { Ed25519SignatureVerifier } from '@michaelhart/meshcore-decoder';

/** How the receiving source got its copy. `rf` and `mqtt_gateway` are real RF hearings. */
export type CrossSourceTransportClass = 'rf' | 'mqtt_gateway' | 'mqtt' | 'udp';

export const CROSS_SOURCE_TRANSPORT_CLASSES: readonly CrossSourceTransportClass[] = [
  'rf', 'mqtt_gateway', 'mqtt', 'udp',
] as const;

/** True for transports that prove an RF path (a radio demodulated the packet). */
export function isRfEdgeTransport(t: CrossSourceTransportClass | null | undefined): boolean {
  return t === 'rf' || t === 'mqtt_gateway';
}

/** Result of classifying one reception. `null` from the classifiers = no correlation. */
export interface CrossSourceTags {
  /** Our source that originated the packet (proven), or null. */
  originSourceId: string | null;
  /** Our source that most likely relayed it (inferred from a short hash), or null. */
  likelyRelaySourceId: string | null;
  /** Every source whose identity matches the relay hash, sorted; [0] === likelyRelaySourceId. */
  likelyRelayCandidates: string[];
  /** How the receiving source got this copy. */
  transport: CrossSourceTransportClass;
}

/**
 * Identity index over the sources a viewer can read. Build it with
 * {@link resolveCrossSourceIndex} (or the constructor in tests).
 */
export class CrossSourceIndex {
  private readonly nodeNumBySource: Map<string, number>;
  private readonly pubKeyBySource: Map<string, string>;
  private readonly sourcesByNodeNum = new Map<number, string[]>();
  private readonly sourcesByRelayByte = new Map<number, string[]>();
  private readonly sourcesByPubKey = new Map<string, string[]>();

  constructor(nodeNums: Map<string, number>, pubKeys: Map<string, string>) {
    this.nodeNumBySource = new Map(nodeNums);
    this.pubKeyBySource = new Map(Array.from(pubKeys, ([s, k]) => [s, k.toLowerCase()]));
    // Sorted so "first candidate" is deterministic across polls.
    for (const sourceId of Array.from(this.nodeNumBySource.keys()).sort()) {
      const n = this.nodeNumBySource.get(sourceId)!;
      push(this.sourcesByNodeNum, n, sourceId);
      push(this.sourcesByRelayByte, n & 0xff, sourceId);
    }
    for (const sourceId of Array.from(this.pubKeyBySource.keys()).sort()) {
      push(this.sourcesByPubKey, this.pubKeyBySource.get(sourceId)!, sourceId);
    }
  }

  /**
   * Sources with a known identity. One is enough: an MQTT source has no
   * identity of its own but can still hear source A. The single-source
   * case is handled by {@link resolveCrossSourceIndex}, which returns an
   * empty index for fewer than two readable sources.
   * Only ever used as a zero-guard, never as a source count (one source can
   * never hold both a nodeNum and a public key today).
   */
  get size(): number {
    return this.nodeNumBySource.size + this.pubKeyBySource.size;
  }

  nodeNumOf(sourceId: string): number | null {
    return this.nodeNumBySource.get(sourceId) ?? null;
  }

  publicKeyOf(sourceId: string): string | null {
    return this.pubKeyBySource.get(sourceId) ?? null;
  }

  /**
   * Coverage-style sender ids (`!xxxxxxxx` for Meshtastic, lowercased 64-hex
   * key for MeshCore) of every indexed source's own node.
   */
  ownSenderIds(): string[] {
    const ids = new Set<string>();
    for (const n of this.nodeNumBySource.values()) ids.add(`!${(n >>> 0).toString(16).padStart(8, '0')}`);
    for (const k of this.pubKeyBySource.values()) ids.add(k);
    return Array.from(ids).sort();
  }

  /** The (first, sorted) indexed source whose own node is `senderId`, or null. */
  ownerOfSenderId(senderId: string): string | null {
    const id = senderId.toLowerCase();
    if (/^[0-9a-f]{64}$/.test(id)) return this.sourcesByPubKey.get(id)?.[0] ?? null;
    if (/^![0-9a-f]{8}$/.test(id)) return this.sourcesByNodeNum.get(parseInt(id.slice(1), 16))?.[0] ?? null;
    return null;
  }

  /** True when `candidate` is a different radio than `receiver` (not the same source, not the same identity). */
  private isOther(candidate: string, receiver: string): boolean {
    if (candidate === receiver) return false;
    const cn = this.nodeNumBySource.get(candidate);
    if (cn !== undefined && cn === this.nodeNumBySource.get(receiver)) return false;
    const ck = this.pubKeyBySource.get(candidate);
    if (ck !== undefined && ck === this.pubKeyBySource.get(receiver)) return false;
    return true;
  }

  /** The readable source (other than `receiverSourceId`) whose local node is `nodeNum`. */
  originForNodeNum(nodeNum: number, receiverSourceId: string): string | null {
    const list = this.sourcesByNodeNum.get(nodeNum) ?? [];
    return list.find((s) => this.isOther(s, receiverSourceId)) ?? null;
  }

  /** Readable sources (other than the receiver) whose nodeNum low byte is `relayByte`. */
  relayCandidatesForByte(relayByte: number, receiverSourceId: string): string[] {
    return (this.sourcesByRelayByte.get(relayByte & 0xff) ?? []).filter((s) => this.isOther(s, receiverSourceId));
  }

  /** The readable MeshCore source (other than the receiver) whose key is `publicKey`. */
  originForPublicKey(publicKey: string, receiverSourceId: string): string | null {
    const list = this.sourcesByPubKey.get(publicKey.toLowerCase()) ?? [];
    return list.find((s) => this.isOther(s, receiverSourceId)) ?? null;
  }

  /** Readable MeshCore sources (other than the receiver) whose key starts with relay hash `hopHex`. */
  relayCandidatesForPathHop(hopHex: string, receiverSourceId: string): string[] {
    const hop = hopHex.toLowerCase();
    if (!/^[0-9a-f]{2,6}$/.test(hop)) return [];
    const out: string[] = [];
    for (const [key, sources] of this.sourcesByPubKey) {
      if (!key.startsWith(hop)) continue;
      for (const s of sources) if (this.isOther(s, receiverSourceId)) out.push(s);
    }
    return out.sort();
  }
}

function push<K>(map: Map<K, string[]>, key: K, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

// ---------------------------------------------------------------------------
// Transport classification
// ---------------------------------------------------------------------------

/**
 * Transport class of a Meshtastic reception. `receiverKind: 'mqtt_gateway'`
 * (a coverage row reported by an MQTT gateway that heard the packet over its
 * own radio) is `mqtt_gateway` regardless of the mechanism. Otherwise the
 * stamped mechanism decides; `null`/absent counts as RF (pre-2.8 firmware
 * omits it; the insert path defaults it to LORA, same rule as
 * `isRfTransport`). INTERNAL and API copies are not hearings at all.
 */
export function meshtasticTransportClass(
  transportMechanism: number | null | undefined,
  receiverKind?: string | null,
): CrossSourceTransportClass | null {
  if (receiverKind === 'mqtt_gateway') return 'mqtt_gateway';
  if (transportMechanism == null) return 'rf';
  switch (transportMechanism) {
    case TransportMechanism.LORA:
    case TransportMechanism.LORA_ALT1:
    case TransportMechanism.LORA_ALT2:
    case TransportMechanism.LORA_ALT3:
      return 'rf';
    case TransportMechanism.MQTT:
      return 'mqtt';
    case TransportMechanism.MULTICAST_UDP:
      return 'udp';
    default:
      return null; // INTERNAL / API / unknown: not a reception
  }
}

/** MeshCore: our own radio heard it (`rf`), or an Observer heard it and published it (`mqtt_gateway`). */
export function meshcoreTransportClass(observerId: string | null | undefined): CrossSourceTransportClass {
  return observerId ? 'mqtt_gateway' : 'rf';
}

// ---------------------------------------------------------------------------
// Classifiers (pure)
// ---------------------------------------------------------------------------

export interface MeshtasticReceptionInput {
  /** The source that logged this copy (B). */
  sourceId: string;
  fromNode: number | null | undefined;
  relayNode?: number | null;
  hopStart?: number | null;
  hopLimit?: number | null;
  transportMechanism?: number | null;
  /** Coverage rows only: `local` (the source's own radio) or `mqtt_gateway`. */
  receiverKind?: string | null;
  /** Coverage gateway rows: the gateway's nodeNum (the node that actually heard it). */
  receiverNodeNum?: number | null;
  /** Skip relay inference (Coverage only cares who sent the fix). */
  originOnly?: boolean;
}

/**
 * Classify one Meshtastic reception against the index. Returns `null` when
 * it is neither from nor (likely) relayed by another readable source.
 */
export function classifyMeshtasticReception(
  index: CrossSourceIndex,
  row: MeshtasticReceptionInput,
): CrossSourceTags | null {
  if (index.size === 0) return null;
  const transport = meshtasticTransportClass(row.transportMechanism, row.receiverKind);
  if (transport === null) return null;

  const from = row.fromNode != null ? Number(row.fromNode) : NaN;
  const reporter = row.receiverKind === 'mqtt_gateway' && row.receiverNodeNum != null
    ? Number(row.receiverNodeNum)
    : null;

  let originSourceId: string | null = null;
  if (Number.isFinite(from) && from > 0) {
    const o = index.originForNodeNum(from, row.sourceId);
    // A gateway that IS the origin is reporting its own packet, not hearing it.
    if (o !== null && reporter !== from) originSourceId = o;
  }

  let likelyRelayCandidates: string[] = [];
  if (!row.originOnly) {
    const relay = row.relayNode != null ? Number(row.relayNode) : NaN;
    const hopStart = row.hopStart != null ? Number(row.hopStart) : NaN;
    const hopLimit = row.hopLimit != null ? Number(row.hopLimit) : NaN;
    const hops = hopStart - hopLimit;
    // relay 0 = firmware did not stamp a relayer; hops 0 = the sender itself
    // is the last hop, so relay_node is just the sender's own low byte.
    if (Number.isFinite(relay) && relay > 0 && Number.isFinite(hops) && hops > 0) {
      likelyRelayCandidates = index
        .relayCandidatesForByte(relay, row.sourceId)
        .filter((s) => index.nodeNumOf(s) !== from)
        .filter((s) => reporter === null || index.nodeNumOf(s) !== reporter);
    }
  }

  if (originSourceId === null && likelyRelayCandidates.length === 0) return null;
  return {
    originSourceId,
    likelyRelaySourceId: likelyRelayCandidates[0] ?? null,
    likelyRelayCandidates,
    transport,
  };
}

/** MeshCore route types whose path lists the relays a packet actually traversed. */
const MESHCORE_FLOOD_ROUTE_TYPES = new Set([0x00, 0x01]); // TRANSPORT_FLOOD, FLOOD

export interface MeshCoreReceptionInput {
  sourceId: string;
  /** Advert sender public key; the CALLER must have verified its signature. Null for non-adverts. */
  advertPublicKey?: string | null;
  /** Relay hash chain, oldest first (lowercase hex per hop). */
  pathHops?: string[] | null;
  routeType?: number | null;
  /** Observer pubkey for an Observer/MQTT copy, null when our own radio heard it. */
  observerId?: string | null;
  originOnly?: boolean;
}

/** Classify one MeshCore reception. Same contract as {@link classifyMeshtasticReception}. */
export function classifyMeshCoreReception(
  index: CrossSourceIndex,
  row: MeshCoreReceptionInput,
): CrossSourceTags | null {
  if (index.size === 0) return null;
  const transport = meshcoreTransportClass(row.observerId);
  const observer = row.observerId ? row.observerId.toLowerCase() : null;

  let originSourceId: string | null = null;
  const senderKey = row.advertPublicKey ? row.advertPublicKey.toLowerCase() : null;
  if (senderKey && senderKey !== observer) {
    originSourceId = index.originForPublicKey(senderKey, row.sourceId);
  }

  let likelyRelayCandidates: string[] = [];
  if (!row.originOnly && row.routeType != null && MESHCORE_FLOOD_ROUTE_TYPES.has(Number(row.routeType))) {
    const set = new Set<string>();
    for (const hop of row.pathHops ?? []) {
      for (const s of index.relayCandidatesForPathHop(hop, row.sourceId)) {
        const key = index.publicKeyOf(s);
        if (key !== null && (key === senderKey || key === observer)) continue;
        set.add(s);
      }
    }
    likelyRelayCandidates = Array.from(set).sort();
  }

  if (originSourceId === null && likelyRelayCandidates.length === 0) return null;
  return {
    originSourceId,
    likelyRelaySourceId: likelyRelayCandidates[0] ?? null,
    likelyRelayCandidates,
    transport,
  };
}

/**
 * Turn a stored MeshCore OTA frame into classifier input. The advert sender
 * key is only returned when it belongs to an indexed source AND its Ed25519
 * signature verifies, so a forged advert claiming one of our keys can never
 * produce an origin tag. Only matching adverts pay for the check. Never throws.
 */
export async function prepareMeshCoreReception(
  index: CrossSourceIndex,
  row: { sourceId: string; rawHex?: string | null; observerId?: string | null; originOnly?: boolean },
): Promise<MeshCoreReceptionInput> {
  const base: MeshCoreReceptionInput = {
    sourceId: row.sourceId, observerId: row.observerId ?? null, originOnly: row.originOnly,
  };
  if (index.size === 0 || !row.rawHex) return base;
  const packet = decodeMeshCorePacket(row.rawHex);
  if (!packet) return base;
  base.routeType = packet.header.routeType;
  base.pathHops = packet.path.direct ? [] : packet.path.hops;
  const advert = packet.header.payloadType === MESHCORE_PAYLOAD_ADVERT ? packet.payload.advert : undefined;
  if (advert && index.originForPublicKey(advert.publicKey, row.sourceId) !== null) {
    try {
      const ok = await Ed25519SignatureVerifier.verifyAdvertisementSignature(
        advert.publicKey, advert.signature, advert.timestamp, advert.appDataHex ?? '',
      );
      if (ok) base.advertPublicKey = advert.publicKey.toLowerCase();
    } catch (err) {
      // treated as unverified
      logger.debug('Cross-source advert signature check threw (treated as unverified):', err);
    }
  }
  return base;
}

// ---------------------------------------------------------------------------
// Permission gate + resolver
// ---------------------------------------------------------------------------

/**
 * The shared permission gate: the source ids the viewer can read under
 * `resource` (admins: every enabled source). Build the index from THIS list
 * and only classify rows from sources in it, and every tag names a source the
 * viewer can read on both ends.
 */
export async function resolveCorrelationSourceIds(req: Request, resource: string): Promise<string[]> {
  return resolvePermittedSourceIds(req, resource);
}

/**
 * Load the identity of every listed source. Persisted values first (so a
 * disconnected source still correlates), then live manager values for any
 * source that has connected but not persisted yet. Never throws: a failure
 * yields an empty index (no tags), never a broken response.
 */
export async function resolveCrossSourceIndex(sourceIds: string[]): Promise<CrossSourceIndex> {
  const ids = Array.from(new Set(sourceIds));
  if (ids.length < 2) return new CrossSourceIndex(new Map(), new Map());
  try {
    // Each lookup is wrapped on its own: `Promise.all([a(), b()])` would leave
    // a()'s rejection unhandled if b() threw synchronously while the array was
    // being built.
    const [nodeNums, pubKeys] = await Promise.all([
      (async () => resolveLocalNodeNums(ids))().catch(() => new Map<string, number>()),
      (async () => databaseService.meshcore.getLocalNodePublicKeysBySource(ids))()
        .catch(() => new Map<string, string>()),
    ]);
    for (const id of ids) {
      if (nodeNums.has(id) || pubKeys.has(id)) continue;
      const manager = sourceManagerRegistry.getManager(id);
      if (!manager) continue;
      try {
        if (isMeshCoreManager(manager)) {
          const k = manager.getLocalNode()?.publicKey;
          if (typeof k === 'string' && /^[0-9a-f]{64}$/i.test(k)) pubKeys.set(id, k.toLowerCase());
        } else if (isMeshtasticManager(manager)) {
          const n = Number(manager.getLocalNodeInfo()?.nodeNum);
          if (Number.isFinite(n) && n > 0) nodeNums.set(id, n);
        }
      } catch {
        // a manager mid-connect must never break the caller
      }
    }
    return new CrossSourceIndex(nodeNums, pubKeys);
  } catch (err) {
    logger.debug('Cross-source identity resolve failed (no tags this request):', err);
    return new CrossSourceIndex(new Map(), new Map());
  }
}
