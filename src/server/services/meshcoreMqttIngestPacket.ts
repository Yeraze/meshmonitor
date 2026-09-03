/**
 * meshcoreMqttIngestPacket
 *
 * Pure, dependency-free DECODER for the MeshCore Analyzer Observer MQTT wire
 * contract — the exact mirror of `meshcoreObserverPacket.ts`'s encoder
 * (issue #5040 Phase 1).
 *
 * `meshcoreObserverPacket.ts` turns a local `OtaPacketEvent` into the JSON an
 * analyzer broker expects on `meshcore/{REGION}/{PUBKEY}/packets`. This module
 * does the reverse: it takes that JSON back off the wire and reconstructs the
 * `OtaPacketEvent` shape, so an MQTT-fed source can hand packets to exactly the
 * same manager seam the local radio path uses
 * (`meshcoreNativeBackend.ts`'s `emitBridgeEvent('ota_packet', …)`).
 *
 * That symmetry is deliberate and load-bearing: everything downstream of
 * `ota_packet` — the packet monitor, the channel-echo correlator, the Virtual
 * Node bridge — then works for an MQTT source with no changes at all.
 *
 * Like the encoder, this module pulls in nothing stateful — only the shared
 * frame parser and pure enum-name helpers — so every function here is
 * golden-testable against fixed hex strings.
 *
 * ## Which shape this produces
 *
 * `OtaPacketEvent` (meshcoreVirtualNodeServer.ts) is the narrow *typed* contract
 * the Virtual Node bridge consumes: `snr`, `rssi`, `raw_hex`, all optional. But
 * the manager's packet-monitor path reads eleven fields off the untyped bridge
 * payload (`meshcoreManager.ts:2164` `handleOtaPacket(data: any)`), including
 * `payload_type`, `route_type`, `path_len_raw`, `hop_count`, `path_hops`,
 * `payload_size` and the two `*_string` names.
 *
 * So this module emits {@link MeshCoreBridgeOtaPacket} — the full shape the
 * native backend emits at `meshcoreNativeBackend.ts:654` — which structurally
 * satisfies `OtaPacketEvent` as well. Producing only the narrow type would
 * typecheck and then silently write packet-monitor rows with every structural
 * column null.
 *
 * ## `raw` is the sole source of truth
 *
 * The encoder's own header states it: the wire payload's `len` / `payload_len`
 * describe the WHOLE FRAME and the payload respectively, but neither is trusted
 * here. Every structural field — payload type, route type, path length, hop
 * count, hop hashes — is re-derived from `raw` with `parseObserverFrame()`, the
 * same function the encoder used to produce them. A publisher that disagrees
 * with its own `raw` (a buggy third-party observer, or a truncated frame) is
 * rejected rather than trusted, so a malformed feed cannot inject a packet whose
 * metadata contradicts its bytes.
 *
 * `SNR` and `RSSI` are the exception — they are measurements, not derivable from
 * the frame, so they come off the wire and are only range-checked.
 *
 * ## What is deliberately NOT reconstructed
 *
 * `payload_type_string` / `route_type_string` are omitted. On the local path
 * those come from the device's own decoder; the wire contract's `packet_type`
 * and `route` are lossy re-encodings (`route` collapses both flood variants to
 * `F`, and both direct variants to `D`/`T`), so re-deriving a string from them
 * would invent detail the feed never carried. Consumers that need a name should
 * resolve it from the numeric `payload_type` / `route_type`.
 */
import { getPayloadTypeName, getRouteTypeName } from '@michaelhart/meshcore-decoder';
import { parseObserverFrame } from './meshcoreObserverPacket.js';
import type { OtaPacketEvent } from '../meshcoreVirtualNodeServer.js';

/**
 * The full bridge payload the native backend emits on `ota_packet`
 * (`meshcoreNativeBackend.ts:654`), and which the manager's packet-monitor path
 * reads. A superset of the typed {@link OtaPacketEvent}, which covers only the
 * three fields the Virtual Node bridge needs.
 */
export interface MeshCoreBridgeOtaPacket extends OtaPacketEvent {
  payload_type: number;
  payload_type_string: string | null;
  route_type: number;
  route_type_string: string | null;
  path_len_raw: number | null;
  hop_count: number;
  path_hops: string[];
  snr?: number | null;
  rssi?: number | null;
  payload_size: number;
  raw_hex: string;
}

/**
 * The subset of the observer wire payload this decoder reads, after validation.
 * Mirrors `ObserverPacketPayload`, but every field is already narrowed.
 */
export interface IngestedObserverPacket {
  /** Publishing observer's node name, as it labelled itself. Never trusted for identity. */
  origin: string;
  /** Publishing observer's public key, UPPER 64-hex. The identity used for per-observer attribution. */
  originId: string;
  /** Publisher's claimed capture time, ISO-8601. Advisory only — never used as a clock. */
  timestamp: string | null;
  /** The reconstructed local-path event, in the full bridge shape. */
  event: MeshCoreBridgeOtaPacket;
}

/** Plausible SNR window in dB. Outside this, the field is dropped rather than trusted. */
const SNR_MIN_DB = -30;
const SNR_MAX_DB = 20;

/** Plausible RSSI window in dBm. */
const RSSI_MIN_DBM = -150;
const RSSI_MAX_DBM = 0;

/** UPPER 64-hex, the observer contract's `origin_id` format. */
const ORIGIN_ID_RE = /^[0-9a-fA-F]{64}$/;

/**
 * Numeric fields arrive as STRINGS on this contract ("every numeric is a
 * string", per the encoder's `ObserverPacketPayload`), but tolerate a real
 * number too — some third-party publishers emit JSON numbers. Anything else,
 * including the encoder's literal `"Unknown"` sentinel for an absent
 * measurement, yields null.
 */
function readNumeric(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === 'Unknown') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** Clamp-or-drop: a measurement outside its plausible window is not a measurement. */
function readMeasurement(value: unknown, min: number, max: number): number | undefined {
  const n = readNumeric(value);
  if (n === null || n < min || n > max) return undefined;
  return n;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Enum-name lookup that degrades to null. The decoder library throws or returns
 * junk for a value outside its enum, and a frame from an unknown/newer firmware
 * carrying an unrecognised payload type must still be logged with its numeric
 * type rather than dropped for want of a display name.
 */
function safeEnumName(lookup: () => string): string | null {
  try {
    const name = lookup();
    return typeof name === 'string' && name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

/**
 * Decode one observer `packets`-topic message into the local `ota_packet`
 * shape. Total: returns null for anything malformed rather than throwing, so a
 * single bad message on a busy region feed can never break the stream.
 *
 * Rejects when: the body isn't an object; `raw` is absent or not hex;
 * `parseObserverFrame` can't structurally parse the frame; or `origin_id` isn't
 * the contract's 64-hex public key (without it there is no per-observer
 * attribution, which the N-rows-deduped-at-query-time design depends on).
 */
export function decodeObserverPacketMessage(body: unknown): IngestedObserverPacket | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const msg = body as Record<string, unknown>;

  // Status messages share the topic prefix but not this shape; skip them
  // quietly rather than logging a parse failure per heartbeat.
  if (msg.type !== undefined && msg.type !== 'PACKET') return null;

  const rawHex = readString(msg.raw);
  if (!rawHex) return null;

  const originId = readString(msg.origin_id);
  if (!originId || !ORIGIN_ID_RE.test(originId)) return null;

  // Re-derive every structural field from `raw` — see the header note on why
  // the wire's own len/payload_len/path are not trusted.
  const frame = parseObserverFrame(rawHex);
  if (!frame.ok) return null;

  const event: MeshCoreBridgeOtaPacket = {
    payload_type: frame.payloadType,
    // Names come from the numeric enums, not from the wire. The contract's
    // `packet_type` / `route` are lossy re-encodings (`route` collapses both
    // flood variants to "F"), so re-reading them would lose detail that
    // `raw` still carries. `getPayloadTypeName` / `getRouteTypeName` are pure
    // lookups over the same enums the local decoder uses.
    payload_type_string: safeEnumName(() => getPayloadTypeName(frame.payloadType)),
    route_type: frame.routeType,
    route_type_string: safeEnumName(() => getRouteTypeName(frame.routeType)),
    path_len_raw: frame.pathLenRaw,
    hop_count: frame.hopCount,
    path_hops: frame.hops,
    snr: readMeasurement(msg.SNR, SNR_MIN_DB, SNR_MAX_DB),
    rssi: readMeasurement(msg.RSSI, RSSI_MIN_DBM, RSSI_MAX_DBM),
    // The frame parser's own byte count, not the wire's `len` — see the header.
    payload_size: frame.totalBytes,
    raw_hex: rawHex.replace(/[^0-9a-fA-F]/g, '').toLowerCase(),
  };

  return {
    origin: readString(msg.origin) ?? '',
    originId: originId.toUpperCase(),
    timestamp: readString(msg.timestamp),
    event,
  };
}

/**
 * Build the subscribe filter for a region.
 *
 * Mirrors `observerTopics()` on the publish side, with a `+` wildcard in the
 * public-key segment so one subscription covers every observer publishing to
 * that region. Region is uppercased to match what the publisher writes.
 */
export function observerPacketsSubscription(region: string): string {
  return `meshcore/${region.trim().toUpperCase()}/+/packets`;
}

/** Same, for the status topic consumed in a later phase. */
export function observerStatusSubscription(region: string): string {
  return `meshcore/${region.trim().toUpperCase()}/+/status`;
}

/**
 * Pull the publishing observer's public key out of a received topic.
 *
 * The message body carries `origin_id` too, and that is what
 * {@link decodeObserverPacketMessage} uses. This exists to CROSS-CHECK the two:
 * a publisher whose body claims a different key than the topic it published on
 * is either buggy or spoofing another observer's identity, and the caller drops
 * it. Returns null when the topic doesn't match the expected shape.
 */
export function observerKeyFromTopic(topic: string): string | null {
  const parts = topic.split('/');
  if (parts.length !== 4) return null;
  if (parts[0] !== 'meshcore') return null;
  if (parts[3] !== 'packets' && parts[3] !== 'status') return null;
  const key = parts[2];
  return ORIGIN_ID_RE.test(key) ? key.toUpperCase() : null;
}
