/**
 * Build `packet:flight` events (#4835) from the three ingest paths.
 *
 * Each builder is pure: it takes what the ingest path already has and returns
 * the small event in `src/types/packetFlight.ts`, or null when there is no
 * edge to draw. Callers check `hasPacketFlightWatchers()` first, so none of
 * this runs while nobody watches. Nothing here reads or writes the database,
 * and nothing here depends on the Packet Monitor log settings.
 *
 * Not one field carries what the packet said: no text, no payload bytes, no
 * decrypted values, no positions.
 */
import type { PacketFlight } from '../../types/packetFlight.js';
import { decodeMeshCorePacket, meshcorePayloadTypeName } from '../../utils/meshcorePacketDecode.js';
import { computeMeshCoreHopsAway } from '../../utils/coverage.js';
import { dataEventEmitter } from './dataEventEmitter.js';
import { hasPacketFlightWatchers } from './packetFlightWatchers.js';
import { logger } from '../../utils/logger.js';

const finiteOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Hops a Meshtastic packet used, from hop_start / hop_limit. Null when hop_start is unset (old firmware). */
export function meshtasticHopsUsed(hopStart: unknown, hopLimit: unknown): number | null {
  if (typeof hopStart !== 'number' || !Number.isInteger(hopStart) || hopStart <= 0) return null;
  const limit = typeof hopLimit === 'number' && Number.isInteger(hopLimit) ? hopLimit : 0;
  if (limit < 0 || limit > hopStart) return null;
  return hopStart - limit;
}

/** The relay_node low byte, or null when unset (0) or not a number. */
export function meshtasticRelayByte(relayNode: unknown): number | null {
  if (typeof relayNode !== 'number' || !Number.isFinite(relayNode)) return null;
  const byte = relayNode & 0xff;
  return byte === 0 ? null : byte;
}

export interface MeshtasticFlightInput {
  sourceId: string;
  fromNum: number;
  localNodeNum: number | null | undefined;
  relayNode?: number | null;
  hopStart?: number | null;
  hopLimit?: number | null;
  kind: string | null;
  snr?: number | null;
  rssi?: number | null;
  viaMqtt?: boolean;
  nowMs?: number;
}

/** A packet the source's own radio received. Null for our own node, or with no local node yet. */
export function buildMeshtasticFlight(input: MeshtasticFlightInput): PacketFlight | null {
  const from = input.fromNum >>> 0;
  const local = input.localNodeNum == null ? null : Number(input.localNodeNum) >>> 0;
  if (!from || local === null || from === local) return null;
  const flight: PacketFlight = {
    sourceId: input.sourceId,
    protocol: 'meshtastic',
    receivedAt: input.nowMs ?? Date.now(),
    from,
    to: local,
    relay: meshtasticRelayByte(input.relayNode),
    hopsUsed: meshtasticHopsUsed(input.hopStart, input.hopLimit),
    kind: input.kind,
    snr: finiteOrNull(input.snr),
    rssi: finiteOrNull(input.rssi),
  };
  if (input.viaMqtt) flight.viaMqtt = true;
  return flight;
}

export interface MqttFlightInput {
  sourceId: string;
  fromNum: number | null | undefined;
  gatewayNodeNum: number | null | undefined;
  relayNode?: number | null;
  hopStart?: number | null;
  hopLimit?: number | null;
  kind: string | null;
  snr?: number | null;
  rssi?: number | null;
  nowMs?: number;
}

/** One gateway's reception on an MQTT source. Null with no sender or no gateway, or a gateway's own packet. */
export function buildMqttFlight(input: MqttFlightInput): PacketFlight | null {
  if (typeof input.fromNum !== 'number' || typeof input.gatewayNodeNum !== 'number') return null;
  const from = input.fromNum >>> 0;
  const gateway = input.gatewayNodeNum >>> 0;
  if (!from || !gateway || from === gateway) return null;
  return {
    sourceId: input.sourceId,
    protocol: 'mqtt',
    receivedAt: input.nowMs ?? Date.now(),
    from,
    to: gateway,
    relay: meshtasticRelayByte(input.relayNode),
    hopsUsed: meshtasticHopsUsed(input.hopStart, input.hopLimit),
    kind: input.kind,
    snr: finiteOrNull(input.snr),
    rssi: finiteOrNull(input.rssi),
  };
}

/** MeshCore payload types whose plaintext prefix is dest_hash(1) | src_hash(1). */
const SRC_HASH_TYPES = new Set([0x00, 0x01, 0x02, 0x08]); // REQ, RESPONSE, TXT_MSG, PATH
const PAYLOAD_ADVERT = 0x04;
const PAYLOAD_ANON_REQ = 0x07;

/**
 * The MeshCore sender, as far as the frame says: an advert's full public key,
 * an ANON_REQ's full sender key, or a message's one-byte src hash. Null for a
 * channel message, an ACK, a trace and the rest, which do not name the sender
 * in the clear.
 */
export function meshcoreSenderOf(rawHex: string | null | undefined): string | null {
  const packet = decodeMeshCorePacket(rawHex);
  if (!packet) return null;
  const type = packet.header.payloadType;
  const hex = packet.payload.hex.toLowerCase();
  if (type === PAYLOAD_ADVERT) return packet.payload.advert?.publicKey?.toLowerCase() ?? null;
  if (type === PAYLOAD_ANON_REQ) return hex.length >= 66 ? hex.slice(2, 66) : null;
  if (SRC_HASH_TYPES.has(type)) return hex.length >= 4 ? hex.slice(2, 4) : null;
  return null;
}

/** The fields of an `ota_packet` event this file reads. */
export interface MeshCoreOtaLike {
  payload_type?: number | null;
  payload_type_string?: string | null;
  route_type?: number | null;
  hop_count?: number | null;
  path_hops?: string[] | null;
  raw_hex?: string | null;
  snr?: number | null;
  rssi?: number | null;
}

export interface MeshCoreFlightInput {
  sourceId: string;
  /** The receiver: the local companion's public key, or the Observer's on a feed source. */
  receiverPubKey: string | null | undefined;
  event: MeshCoreOtaLike;
  nowMs?: number;
}

/** A MeshCore frame heard by the local radio (or an Observer). Null when it has neither a sender nor a last hop. */
export function buildMeshCoreFlight(input: MeshCoreFlightInput): PacketFlight | null {
  const to = input.receiverPubKey ? input.receiverPubKey.toLowerCase() : null;
  if (!to) return null;
  const e = input.event ?? {};
  const pathHops = Array.isArray(e.path_hops) ? e.path_hops.filter((h) => typeof h === 'string' && h.length > 0) : [];
  const hopCount = typeof e.hop_count === 'number' ? e.hop_count : pathHops.length;
  const hopsUsed = computeMeshCoreHopsAway(e.route_type ?? null, hopCount);
  // Only a flood path lists the hops already taken; a direct path lists the
  // hops still to go, so its last entry is not the node we heard it from.
  const relay = hopsUsed !== null && hopsUsed > 0 && pathHops.length > 0
    ? pathHops[pathHops.length - 1].toLowerCase()
    : null;
  const from = meshcoreSenderOf(e.raw_hex);
  if (!from && !relay) return null;
  if (from && from === to) return null;
  const kind = e.payload_type_string
    ?? (typeof e.payload_type === 'number' ? meshcorePayloadTypeName(e.payload_type) : null);
  return {
    sourceId: input.sourceId,
    protocol: 'meshcore',
    receivedAt: input.nowMs ?? Date.now(),
    from,
    to,
    relay,
    hopsUsed,
    kind,
    snr: finiteOrNull(e.snr),
    rssi: finiteOrNull(e.rssi),
  };
}

/**
 * Build and emit one flight, only while someone watches the source. Never
 * throws into the ingest path.
 */
export function emitPacketFlight(sourceId: string, build: () => PacketFlight | null): void {
  if (!hasPacketFlightWatchers(sourceId)) return;
  try {
    const flight = build();
    if (flight) dataEventEmitter.emitPacketFlight(flight);
  } catch (err) {
    logger.debug(`[PacketFlights] Could not build a flight for ${sourceId}:`, err);
  }
}
