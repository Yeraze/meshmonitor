/**
 * MeshCore TRACE decoding, shared by every backend (#5722, #5742).
 *
 * Two inputs carry a TRACE:
 *
 * 1. A Companion radio's `TraceData (0x89)` push: the firmware's summary of a
 *    trace that has reached the end of its path ({@link parseTraceDataPush}).
 * 2. The raw over-the-air packet, as a Repeater prints it on its serial log
 *    ({@link decodeTracePacket}). This can be any stage of the trace's trip.
 *
 * Both become one {@link TraceDataEvent}, which the ingest service stores.
 *
 * Wire layout of a TRACE packet (firmware `Packet::writeTo`, `Mesh::createTrace`,
 * `Mesh::sendDirect`, `Mesh::onRecvPacket`):
 *
 *   header        1 byte   bits 0-1 route type, bits 2-5 payload type (9 = TRACE)
 *   transport     4 bytes  only when the route type is TRANSPORT_DIRECT (3)
 *   path_len      1 byte   for TRACE: a plain count of the SNR bytes that follow
 *   path          N bytes  one signed quarter-dB SNR per hop that has forwarded
 *   payload       tag (u32 LE), auth code (u32 LE), flags (1 byte), path hashes
 *
 * A TRACE turns the usual packet layout around: the hop hashes ride in the
 * payload and the `path` field holds SNRs. Each forwarding hop appends the SNR
 * at which IT heard the packet, then re-transmits. `flags & 0x03` is the hash
 * width as a power of two (0 = 1 byte, 1 = 2 bytes).
 */

/** Bridge-event payload for one heard TRACE (`trace_data`). */
export interface TraceDataEvent {
  tag: number;
  auth_code: number;
  flags: number;
  /** 1 or 2 in current firmware (`1 << (flags & 0x03)`). */
  hash_bytes: number;
  path_hashes_hex: string;
  /**
   * Signed quarter-dB, one per hop that has forwarded. A Companion push always
   * carries one per hash. A packet a Repeater caught in flight carries fewer.
   */
  path_snrs_q: number[];
  /**
   * Signed quarter-dB at our own radio, hearing the packet's last transmitter.
   * Null only for a Repeater packet with no paired RX line.
   */
  last_snr_q: number | null;
  /** True when this backend sent the trace. */
  initiated: boolean;
}

/** meshcore.js's internal BufferReader surface, as the push parser uses it. */
export interface TraceDataBufferReader {
  readByte(): number;
  readUInt8(): number;
  readUInt32LE(): number;
  readBytes(count: number): Uint8Array;
  readInt8(): number;
}

/** Parsed TraceData(0x89) push. */
export interface TraceDataResponse {
  reserved: number;
  pathLen: number;
  flags: number;
  tag: number;
  authCode: number;
  pathHashes: Uint8Array;
  pathSnrs: Uint8Array;
  /** dB (the wire byte / 4). */
  lastSnr: number;
}

/**
 * Corrected TraceData(0x89) push parser. The pinned meshcore.js reads
 * `pathSnrs` as `pathLen` bytes (the raw hash byte count) instead of the hop
 * count (`pathLen >> path_sz`), so a 2-byte-hop reply over-reads into
 * `lastSnr` and desyncs (#4786). Installed for the whole session since #5722,
 * so traces this radio merely overhears parse correctly too.
 */
export function parseTraceDataPush(bufferReader: TraceDataBufferReader): TraceDataResponse {
  const reserved = bufferReader.readByte();
  const pathLen = bufferReader.readUInt8();
  const flags = bufferReader.readUInt8();
  const pathSz = flags & 0x03;
  const tag = bufferReader.readUInt32LE();
  const authCode = bufferReader.readUInt32LE();
  const pathHashes = bufferReader.readBytes(pathLen);
  const hopCount = pathSz > 0 ? pathLen >> pathSz : pathLen;
  const pathSnrs = bufferReader.readBytes(hopCount);
  const lastSnr = bufferReader.readInt8() / 4;
  return { reserved, pathLen, flags, tag, authCode, pathHashes, pathSnrs, lastSnr };
}

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const toInt8 = (b: number): number => (b << 24) >> 24;

/** Hash width in bytes from a TRACE flags byte. */
export function traceHashBytes(flags: number): number {
  return 1 << (flags & 0x03);
}

/** Build the bridge event from a parsed Companion push. */
export function traceDataEventFromPush(trace: TraceDataResponse, initiated: boolean): TraceDataEvent {
  return {
    tag: trace.tag >>> 0,
    auth_code: trace.authCode >>> 0,
    flags: trace.flags,
    hash_bytes: traceHashBytes(trace.flags),
    path_hashes_hex: toHex(trace.pathHashes),
    // Per-hop SNR in signed quarter-dB (the wire unit).
    path_snrs_q: Array.from(trace.pathSnrs, toInt8),
    last_snr_q: Math.round(trace.lastSnr * 4),
    initiated,
  };
}

export const MESHCORE_PAYLOAD_TYPE_TRACE = 0x09;
const ROUTE_TYPE_DIRECT = 0x02;
const ROUTE_TYPE_TRANSPORT_DIRECT = 0x03;
/** tag (4) + auth code (4) + flags (1). */
const TRACE_PAYLOAD_HEADER_BYTES = 9;

/** One TRACE packet as it was on the air. */
export interface DecodedTracePacket {
  tag: number;
  authCode: number;
  flags: number;
  hashBytes: number;
  /** Every hop on the trace's path, in order. */
  pathHashes: Uint8Array;
  /** Signed quarter-dB, one per hop that had forwarded when the packet was sent. */
  pathSnrsQ: number[];
  /** Hops on the path. */
  hopCount: number;
  /** True when every hop has forwarded: the packet is on its last leg. */
  complete: boolean;
}

/**
 * Decode a raw over-the-air packet as a TRACE. Returns null for any other
 * packet type and for a frame that does not hold together; never throws.
 */
export function decodeTracePacket(rawHex: string): DecodedTracePacket | null {
  if (typeof rawHex !== 'string' || rawHex.length < 4 || rawHex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(rawHex)) return null;
  const bytes = new Uint8Array(rawHex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(rawHex.slice(i * 2, i * 2 + 2), 16);

  const header = bytes[0];
  if (((header >> 2) & 0x0f) !== MESHCORE_PAYLOAD_TYPE_TRACE) return null;
  // TRACE is direct-only: `Mesh::sendFlood` refuses it and `onRecvPacket`
  // handles it only when `isRouteDirect()`.
  const routeType = header & 0x03;
  if (routeType !== ROUTE_TYPE_DIRECT && routeType !== ROUTE_TYPE_TRANSPORT_DIRECT) return null;

  let offset = 1;
  if (routeType === ROUTE_TYPE_TRANSPORT_DIRECT) offset += 4;
  if (offset >= bytes.length) return null;

  // For TRACE the byte is a plain SNR count. A set top bit would mean a
  // multi-byte path entry, which no trace has.
  const snrCount = bytes[offset++];
  if (snrCount > 63) return null;
  if (offset + snrCount + TRACE_PAYLOAD_HEADER_BYTES > bytes.length) return null;
  const pathSnrsQ = Array.from(bytes.subarray(offset, offset + snrCount), toInt8);
  offset += snrCount;

  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, TRACE_PAYLOAD_HEADER_BYTES);
  const tag = view.getUint32(0, true);
  const authCode = view.getUint32(4, true);
  const flags = view.getUint8(8);
  offset += TRACE_PAYLOAD_HEADER_BYTES;

  const hashBytes = traceHashBytes(flags);
  const pathHashes = bytes.slice(offset);
  if (pathHashes.length === 0 || pathHashes.length % hashBytes !== 0) return null;
  const hopCount = pathHashes.length / hashBytes;
  // More SNRs than hops cannot happen: a hop forwards only while SNRs < hops.
  if (snrCount > hopCount) return null;

  return { tag, authCode, flags, hashBytes, pathHashes, pathSnrsQ, hopCount, complete: snrCount === hopCount };
}

/**
 * Build the bridge event from a packet a Repeater heard on the air.
 *
 * @param rxSnrDb SNR of this reception in whole dB, from the paired RX log
 *   line (the firmware prints `(int)snr`); undefined when there was none.
 */
export function traceDataEventFromPacket(packet: DecodedTracePacket, rxSnrDb: number | undefined): TraceDataEvent {
  const q = typeof rxSnrDb === 'number' && Number.isFinite(rxSnrDb) ? Math.round(rxSnrDb * 4) : null;
  return {
    tag: packet.tag >>> 0,
    auth_code: packet.authCode >>> 0,
    flags: packet.flags,
    hash_bytes: packet.hashBytes,
    path_hashes_hex: toHex(packet.pathHashes),
    path_snrs_q: packet.pathSnrsQ,
    last_snr_q: q !== null && q >= -128 && q <= 127 ? q : null,
    // A repeater source cannot send a trace.
    initiated: false,
  };
}
