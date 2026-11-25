/**
 * Pure credit rules for Walkabout capture (#5891 Phase 1). Spec §2.6.
 *
 * A reception is credited to the node whose radio we heard, never to a guess:
 * direct hearing credits the sender; a relayed copy credits the relayer only
 * when it resolves to exactly one known node; anything else is skipped with a
 * reason the service counts.
 *
 * MeshCore routing facts (firmware `src/Mesh.cpp`, meshcore-dev/MeshCore at
 * commit 75b04ef06def54b348400cb1b138afb6749ffd4f, checked 2026-11-25):
 *  - Flood: `Mesh::routeRecvPacket` (~L280-290) appends the repeater's own hash
 *    to `path` before it retransmits, so the path lists hops already taken and
 *    its last entry is the node whose radio we heard.
 *  - Direct: `Mesh::onRecvPacket` (~L77-104) forwards only when the FIRST path
 *    entry matches `self_id`, then calls `removeSelfFromPath` (~L334-340),
 *    which shifts the path left by one entry. A non-empty path is therefore
 *    still in transit, and an EMPTY path means "arrived" without saying whether
 *    the origin or the last repeater sent the copy we heard. We cannot tell
 *    them apart, so we skip it (`direct-route-ambiguous`).
 */
import type { MeshtasticDirectRfPacket } from '../services/directRfContactRecorder.js';
import { resolveUniqueRelayNode, type LastHopCandidate } from './lastHop.js';
import { decodeMeshCorePacket, type DecodedAdvert } from '../../utils/meshcorePacketDecode.js';
import {
  MESHCORE_PAYLOAD_ADVERT,
  MESHCORE_ROUTE_FLOOD,
  MESHCORE_ROUTE_TRANSPORT_FLOOD,
  computeMeshCoreHopsAway,
  computeMeshtasticHopsAway,
  isMeshCorePubKeyId,
  nodeNumToId,
} from '../../utils/coverage.js';
import { isRfTransport, isNodeDbReplayForPacketLog } from '../services/packetLogDedup.js';
import { resolveRadioPacketTransport, isViaMqtt } from '../constants/meshtastic.js';
import { isLiveReception } from './replayGuard.js';
import { meshcoreSenderOf } from '../services/packetFlights.js';
import { resolvePathHash } from '../services/meshcoreTraceIngestService.js';
import { calculateMeshCorePacketHash } from '../services/meshcoreObserverPacket.js';

export type WalkaboutSkip =
  | 'no-local-node' | 'replayed' | 'own-packet' | 'via-mqtt' | 'not-rf' | 'no-packet-id'
  | 'not-live' | 'nodedb-replay' | 'unknown-hops' | 'relay-none' | 'relay-unknown' | 'relay-ambiguous'
  | 'decode-failed' | 'no-sender' | 'direct-route-ambiguous' | 'own-advert';

export interface WalkaboutCredit {
  protocol: 'meshtastic' | 'meshcore';
  /** `!xxxxxxxx` or lowercased 64-hex key. */
  creditedKey: string;
  creditedNodeNum: number | null;
  creditKind: 'direct' | 'relay';
  hopsAway: number;
  packetKey: string;
  snr: number | null;
  rssi: number | null;
}

/** -128 is the firmware "no SNR" sentinel; 0 dB is a real reading. */
function cleanSnr(v: number | null | undefined): number | null {
  return v != null && Number.isFinite(v) && v !== -128 ? v : null;
}
/** An explicit 0 is kept. */
function cleanRssi(v: number | null | undefined): number | null {
  return v != null && Number.isFinite(v) ? v : null;
}

export function evaluateWalkaboutMeshtastic(input: {
  localNodeNum: number | null;
  packet: MeshtasticDirectRfPacket & { relayNode?: number | null };
  replayed: boolean;
  nowMs: number;
  candidates: LastHopCandidate[];
}): { skip: WalkaboutSkip } | { skip: null; credit: WalkaboutCredit } {
  const p = input.packet;
  if (input.localNodeNum === null) return { skip: 'no-local-node' };
  if (input.replayed) return { skip: 'replayed' };
  const fromNum = p.from ? Number(p.from) : 0;
  if (!fromNum || fromNum === input.localNodeNum) return { skip: 'own-packet' };
  if (p.viaMqtt === true || isViaMqtt(p.transportMechanism ?? undefined)) return { skip: 'via-mqtt' };
  const transport = resolveRadioPacketTransport(p);
  if (!isRfTransport(transport)) return { skip: 'not-rf' };
  const packetId = p.id ? Number(p.id) : 0;
  if (!packetId) return { skip: 'no-packet-id' };
  const rxTimeSec = p.rxTime != null ? Number(p.rxTime) : null;
  if (!isLiveReception(rxTimeSec ?? undefined, input.nowMs)) return { skip: 'not-live' };
  if (isNodeDbReplayForPacketLog(transport, rxTimeSec, p.rxRssi ?? null, input.nowMs, { fromNum, packetId })) {
    return { skip: 'nodedb-replay' };
  }
  const hopsAway = computeMeshtasticHopsAway({
    hopStart: p.hopStart ?? null,
    hopLimit: p.hopLimit ?? null,
    hasBitfield: typeof p.decoded?.bitfield === 'number',
  });
  if (hopsAway === null) return { skip: 'unknown-hops' };

  const base = {
    protocol: 'meshtastic' as const,
    hopsAway,
    packetKey: `${fromNum.toString(16).padStart(8, '0')}:${packetId}`,
    snr: cleanSnr(p.rxSnr),
    rssi: cleanRssi(p.rxRssi),
  };
  const relayByte = p.relayNode != null ? Number(p.relayNode) & 0xff : 0;
  // Zero hops is normally a direct hearing. Firmware keeps hop_limit unchanged when a ROUTER /
  // ROUTER_LATE / CLIENT_BASE relays for a unique favourite relay router
  // (meshtastic/firmware src/mesh/Router.cpp shouldDecrementHopLimit ~L283-300, used by
  // NextHopRouter.cpp ~L280-288, develop at 12f9b997), so a relayed copy can show 0 hops.
  // A direct copy carries the sender's own low byte as relay_node (and 0 when hop_start is 0),
  // so a different non-zero byte means someone else transmitted it.
  const relayedAtZeroHops = hopsAway === 0 && relayByte !== 0 && relayByte !== (fromNum & 0xff);
  if (hopsAway === 0 && !relayedAtZeroHops) {
    return { skip: null, credit: { ...base, creditedKey: nodeNumToId(fromNum), creditedNodeNum: fromNum, creditKind: 'direct' } };
  }
  if (!relayByte) return { skip: 'relay-none' };
  const { nodeNum, matches } = resolveUniqueRelayNode(relayByte, input.candidates, [input.localNodeNum, fromNum]);
  if (matches === 0) return { skip: 'relay-unknown' };
  if (matches > 1 || nodeNum === null) return { skip: 'relay-ambiguous' };
  return { skip: null, credit: { ...base, creditedKey: nodeNumToId(nodeNum), creditedNodeNum: nodeNum, creditKind: 'relay' } };
}

/**
 * `knownKeys`: every `meshcore_nodes` key on the source, minus our own. Used
 * for a direct sender's hash. `relayKeys` (Q3: repeaters and room servers
 * only) narrows the relay lookup; it defaults to `knownKeys`.
 */
export function evaluateWalkaboutMeshCore(input: {
  localPubKey: string | null;
  event: { raw_hex?: string | null; snr?: number | null; rssi?: number | null };
  knownKeys: string[];
  relayKeys?: string[];
}): { skip: WalkaboutSkip } | { skip: null; credit: WalkaboutCredit; verifyAdvert?: DecodedAdvert } {
  const rawHex = input.event.raw_hex;
  const packet = rawHex ? decodeMeshCorePacket(rawHex) : null;
  if (!rawHex || !packet) return { skip: 'decode-failed' };
  const local = input.localPubKey ? input.localPubKey.toLowerCase() : null;
  const { routeType, payloadType } = packet.header;
  const hopsAway = computeMeshCoreHopsAway(routeType, packet.path.hopCount);
  if (hopsAway === null) return { skip: 'unknown-hops' };

  const base = {
    protocol: 'meshcore' as const,
    creditedNodeNum: null,
    hopsAway,
    packetKey: calculateMeshCorePacketHash(rawHex),
    snr: cleanSnr(input.event.snr),
    rssi: cleanRssi(input.event.rssi),
  };

  // Adverts are never direct-routed through repeaters, so zero hops means the sender transmitted it.
  if (payloadType === MESHCORE_PAYLOAD_ADVERT && hopsAway === 0) {
    const advert = packet.payload.advert;
    if (!advert || !isMeshCorePubKeyId(advert.publicKey)) return { skip: 'decode-failed' };
    const key = advert.publicKey.toLowerCase();
    if (local && key === local) return { skip: 'own-advert' };
    return { skip: null, credit: { ...base, creditedKey: key, creditKind: 'direct' }, verifyAdvert: advert };
  }

  const isFlood = routeType === MESHCORE_ROUTE_FLOOD || routeType === MESHCORE_ROUTE_TRANSPORT_FLOOD;
  if (!isFlood) return { skip: 'direct-route-ambiguous' }; // empty path (a non-empty one is `unknown-hops` above)

  if (hopsAway === 0) {
    const sender = meshcoreSenderOf(rawHex);
    if (!sender) return { skip: 'no-sender' };
    if (sender.length >= 64) {
      if (local && sender === local) return { skip: 'own-packet' };
      return input.knownKeys.some((k) => k.toLowerCase() === sender)
        ? { skip: null, credit: { ...base, creditedKey: sender, creditKind: 'direct' } }
        : { skip: 'relay-unknown' };
    }
    const r = resolvePathHash(sender, input.knownKeys);
    if (r.candidates === 0) return { skip: 'relay-unknown' };
    if (!r.publicKey) return { skip: 'relay-ambiguous' };
    return { skip: null, credit: { ...base, creditedKey: r.publicKey.toLowerCase(), creditKind: 'direct' } };
  }

  // Flood, relayed: only a flood path lists the hops already taken, so its last entry sent this copy.
  const lastHop = packet.path.hops[packet.path.hops.length - 1];
  if (!lastHop) return { skip: 'relay-none' };
  const r = resolvePathHash(lastHop, input.relayKeys ?? input.knownKeys);
  if (r.candidates === 0) return { skip: 'relay-unknown' };
  if (!r.publicKey) return { skip: 'relay-ambiguous' };
  return { skip: null, credit: { ...base, creditedKey: r.publicKey.toLowerCase(), creditKind: 'relay' } };
}
