/**
 * meshcoreObserverPacket
 *
 * Pure, dependency-free encoder for the MeshCore Analyzer Observer MQTT wire
 * contract (#4457 Phase 2, WP1). Turns a raw OTA packet event (or a
 * status transition) into the exact JSON shape a
 * `michaelhart/meshcore-mqtt-broker`-compatible analyzer expects on
 * `meshcore/{REGION}/{PUBLIC_KEY}/{packets|status}`.
 *
 * This module imports nothing but `node:crypto` and the `OtaPacketEvent`
 * type (type-only, erased at compile time) — no manager, no DB, no mqtt, no
 * logger. That is what makes every function here golden-testable with fixed
 * hex strings and a fixed `Date`, and safe to reuse from both the publisher
 * service and any future consumer.
 *
 * Wire contract verified against `michaelhart/meshcore-packet-capture`'s
 * `packet_capture.py` (`format_packet_data()`, `calculate_packet_hash()`) —
 * see `docs/internal/dev-notes/MESHCORE_OBSERVER_PHASE2_SPEC.md` §2 for the
 * full derivation, including the deliberate deviations:
 *   - D-2: `hash` is SHA-256-derived (`calculateMeshCorePacketHash` below),
 *     NOT `@michaelhart/meshcore-decoder`'s 32-bit djb2 `messageHash`.
 *   - D-3: the path/payload boundary uses the *packed* `path_len` decode
 *     (`hashSize=(b>>6)+1`, `hopCount=b&0x3f`), not a plain byte count. The
 *     two agree for `b <= 0x3f` (effectively all real traffic).
 *   - D-4: no decoded advert fields are ever published; the reference's own
 *     "opt-in" privacy filter is a no-op on the wire (verified dead code).
 *   - D-8: `timestamp` is UTC ISO-8601 (`Z`), not the reference's naive
 *     local `datetime.now().isoformat()`.
 *
 * `raw_hex` is the sole source of truth — the `OtaPacketEvent`'s
 * `payload_size`-equivalent fields (when present elsewhere in the codebase)
 * describe the WHOLE FRAME, not the payload; nothing here trusts anything
 * but `raw_hex`, `snr`, and `rssi` off the event.
 */
import { createHash } from 'node:crypto';
import type { OtaPacketEvent } from '../meshcoreVirtualNodeServer.js';

/** Contract payload published to meshcore/{REGION}/{PUBKEY}/packets. Every numeric is a string. */
export interface ObserverPacketPayload {
  origin: string;
  origin_id: string;
  timestamp: string;
  type: 'PACKET';
  direction: 'rx';
  time: string;
  date: string;
  len: string;
  packet_type: string;
  route: 'F' | 'D' | 'T' | 'U';
  payload_len: string;
  raw: string;
  SNR: string;
  RSSI: string;
  hash: string;
  /** Present ONLY when route === 'D'. Comma-joined 2-hex-char hop tokens. */
  path?: string;
}

export interface ObserverStatusPayload {
  status: 'online' | 'offline';
  timestamp: string;
  origin: string;
  origin_id: string;
  model?: string;
  firmware_version?: string;
  radio?: string;
  client_version?: string;
}

export interface ObserverPacketIdentity {
  origin: string;
  originId: string; // UPPER 64-hex
}

/** Structural parse of an OTA frame. Never throws; `ok:false` on any problem. */
export interface ObserverFrameParse {
  ok: boolean;
  payloadType: number; // 0..15
  routeType: number; // 0..3
  pathLenRaw: number | null;
  hopCount: number;
  hashSize: number;
  /** Per-hop relay hashes, lowercase hex, `hashSize` bytes each. */
  hops: string[];
  payloadStart: number; // byte offset of the payload
  payloadLen: number;
  totalBytes: number;
}

const SENTINEL_HASH = '0000000000000000';

/** `route_type` (0..3) → contract `route` letter. TRANSPORT_DIRECT (0x03) maps to "T", not "D". */
const ROUTE_LETTER: Record<number, 'F' | 'D' | 'T'> = {
  0x00: 'F', // TRANSPORT_FLOOD
  0x01: 'F', // FLOOD
  0x02: 'D', // DIRECT
  0x03: 'T', // TRANSPORT_DIRECT
};

// ── Byte helpers (reimplemented locally — no import, per the pure-module rule) ──

function hexToBytesLocal(hex: string | null | undefined): Uint8Array {
  const clean = (hex ?? '').replace(/[^0-9a-fA-F]/g, '');
  const len = Math.floor(clean.length / 2);
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHexLocal(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `HH:MM:SS`, from the Date's LOCAL getters (reference parity). */
function formatLocalTime(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** `DD/MM/YYYY`, from the Date's LOCAL getters (reference parity). */
function formatLocalDate(d: Date): string {
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/** `String(n)` for a real number (including 0), else the literal `"Unknown"`. */
function formatNumberOrUnknown(v: number | null | undefined): string {
  return typeof v === 'number' ? String(v) : 'Unknown';
}

/**
 * Decode a packed path_len byte → total path bytes on the wire (D-3).
 * `0xff` (direct, no relay hashes) ⇒ 0.
 * For `b <= 0x3f` this equals `b` — identical to a plain byte-count read.
 */
export function pathByteLength(pathLenRaw: number): number {
  if (pathLenRaw === 0xff) return 0;
  return (pathLenRaw & 0x3f) * (((pathLenRaw >> 6) & 0x03) + 1);
}

/**
 * Structural parse from raw hex. Total; never throws.
 *
 * `ok` is false when: fewer than 2 bytes; truncated before/inside transport
 * codes; truncated before `path_len`; truncated path; `payloadStart >
 * totalBytes`; the reserved `hashSize === 4` (bits 7:6 = `11`); or
 * `payloadVersion !== 0` (mirrors the reference's VER_1-only gate).
 *
 * Even when `ok` is false, `payloadType`/`routeType`/`hopCount`/`hashSize`/
 * `payloadStart`/`payloadLen` are still populated whenever the parse could
 * validly reach that point — this is what lets the encoder's parse agree
 * with `decodeMeshCorePacket()` on a version-1 fixture even though our
 * `ok` differs.
 */
export function parseObserverFrame(rawHex: string): ObserverFrameParse {
  const bytes = hexToBytesLocal(rawHex);
  const totalBytes = bytes.length;

  const empty: ObserverFrameParse = {
    ok: false,
    payloadType: 0,
    routeType: 0,
    pathLenRaw: null,
    hopCount: 0,
    hashSize: 0,
    hops: [],
    payloadStart: 0,
    payloadLen: 0,
    totalBytes,
  };

  if (totalBytes < 2) {
    return empty;
  }

  const header = bytes[0];
  const payloadType = (header >> 2) & 0x0f;
  const routeType = header & 0x03;
  const payloadVersion = (header >> 6) & 0x03;

  let offset = 1;
  const hasTransportCodes = routeType === 0x00 || routeType === 0x03;
  if (hasTransportCodes) {
    if (offset + 4 > totalBytes) {
      return { ...empty, payloadType, routeType };
    }
    offset += 4;
  }

  if (offset >= totalBytes) {
    return { ...empty, payloadType, routeType };
  }

  const pathLenRaw = bytes[offset];
  offset += 1;

  let hopCount = 0;
  let hashSize = 0;
  const hops: string[] = [];

  if (pathLenRaw !== 0xff) {
    hashSize = (pathLenRaw >> 6) + 1;
    hopCount = pathLenRaw & 0x3f;
    const pathBytes = hopCount * hashSize;
    if (offset + pathBytes > totalBytes) {
      return { ...empty, payloadType, routeType, pathLenRaw, hopCount, hashSize };
    }
    for (let i = 0; i < hopCount; i++) {
      const start = offset + i * hashSize;
      hops.push(bytesToHexLocal(bytes.subarray(start, start + hashSize)));
    }
    offset += pathBytes;
  }

  const payloadStart = offset;
  const truncatedPayload = payloadStart > totalBytes;
  const reservedHashSize = hashSize === 4;
  const payloadLen = truncatedPayload ? 0 : totalBytes - payloadStart;

  const ok = !truncatedPayload && !reservedHashSize && payloadVersion === 0;

  return {
    ok,
    payloadType,
    routeType,
    pathLenRaw,
    hopCount,
    hashSize,
    hops,
    payloadStart: Math.min(payloadStart, totalBytes),
    payloadLen,
    totalBytes,
  };
}

/**
 * MeshCore `Packet::calculatePacketHash` — SHA-256 over
 * [payload_type] (+ uint16le(path_len_raw) for TRACE) + payload,
 * first 8 bytes as 16 UPPERCASE hex chars.
 * Returns '0000000000000000' on any parse failure (reference parity).
 *
 * Deliberately independent of `parseObserverFrame`'s `ok` gate — this
 * replicates the reference's `calculate_packet_hash()` verbatim, which does
 * not check `payloadVersion` or the reserved hash-size case, only structural
 * truncation.
 */
export function calculateMeshCorePacketHash(rawHex: string): string {
  try {
    const bytes = hexToBytesLocal(rawHex);
    if (bytes.length < 1) return SENTINEL_HASH;

    const header = bytes[0];
    const payloadType = (header >> 2) & 0x0f;
    const routeType = header & 0x03;

    let offset = 1 + (routeType === 0x00 || routeType === 0x03 ? 4 : 0);
    if (offset >= bytes.length) return SENTINEL_HASH; // no path_len byte available

    const pathLenRaw = bytes[offset];
    offset += 1;
    // 0xff is the firmware sentinel for "sent direct, no relay hops" —
    // pathByteLength maps it to 0, so no hop bytes are skipped before the
    // payload. Same net layout parseObserverFrame produces via its explicit
    // pathLenRaw !== 0xff branch.
    offset += pathByteLength(pathLenRaw);

    const payload = bytes.subarray(Math.min(offset, bytes.length));

    const sha = createHash('sha256');
    sha.update(Uint8Array.from([payloadType]));
    if (payloadType === 0x09) {
      // TRACE: prefix with uint16le(path_len_raw).
      const le = new Uint8Array(2);
      le[0] = pathLenRaw & 0xff;
      le[1] = (pathLenRaw >> 8) & 0xff;
      sha.update(le);
    }
    sha.update(payload);

    return sha.digest('hex').slice(0, 16).toUpperCase();
  } catch {
    return SENTINEL_HASH;
  }
}

/** Build the analyzer-contract packet payload. Never throws. `null` iff `raw_hex` is missing/blank. */
export function buildObserverPacketPayload(
  event: OtaPacketEvent,
  identity: ObserverPacketIdentity,
  now: Date = new Date(),
): ObserverPacketPayload | null {
  const rawHexInput = event.raw_hex;
  if (!rawHexInput || rawHexInput.trim() === '') return null;

  const raw = rawHexInput.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  const parse = parseObserverFrame(rawHexInput);
  const hash = calculateMeshCorePacketHash(rawHexInput);

  const route: ObserverPacketPayload['route'] = parse.ok ? (ROUTE_LETTER[parse.routeType] ?? 'U') : 'U';
  const packetType = parse.ok ? String(parse.payloadType) : '0';
  const payloadLen = parse.ok ? String(Math.max(0, parse.payloadLen)) : '0';

  const payload: ObserverPacketPayload = {
    origin: identity.origin,
    origin_id: identity.originId.toUpperCase(),
    timestamp: now.toISOString(),
    type: 'PACKET',
    direction: 'rx',
    time: formatLocalTime(now),
    date: formatLocalDate(now),
    len: String(parse.totalBytes),
    packet_type: packetType,
    route,
    payload_len: payloadLen,
    raw,
    SNR: formatNumberOrUnknown(event.snr),
    RSSI: formatNumberOrUnknown(event.rssi),
    hash,
  };

  if (route === 'D') {
    payload.path = parse.ok ? parse.hops.join(',') : '';
  }

  return payload;
}

/** Build the analyzer-contract status payload (online or offline/LWT). */
export function buildObserverStatusPayload(
  status: 'online' | 'offline',
  identity: ObserverPacketIdentity,
  device?: { model?: string; firmwareVersion?: string; radio?: string; clientVersion?: string },
  now: Date = new Date(),
): ObserverStatusPayload {
  const base: ObserverStatusPayload = {
    status,
    timestamp: now.toISOString(),
    origin: identity.origin,
    origin_id: identity.originId.toUpperCase(),
  };

  if (status !== 'online') {
    return base; // LWT / graceful-offline form: no device sub-fields.
  }

  return {
    ...base,
    model: device?.model ?? 'unknown',
    firmware_version: device?.firmwareVersion ?? 'unknown',
    radio: device?.radio ?? 'unknown',
    client_version: device?.clientVersion ?? 'unknown',
  };
}

/** meshcore/{region}/{PUBKEY}/{packets|status}. Applies the `test`-lowercase rule. */
export function observerTopics(
  iataCode: string,
  publicKey: string,
): { region: string; packets: string; status: string } {
  const region = iataCode.toLowerCase() === 'test' ? 'test' : iataCode.toUpperCase();
  const pubkey = publicKey.toUpperCase();
  return {
    region,
    packets: `meshcore/${region}/${pubkey}/packets`,
    status: `meshcore/${region}/${pubkey}/status`,
  };
}
