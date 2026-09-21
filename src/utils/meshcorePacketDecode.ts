/**
 * Best-effort decoder for a MeshCore OTA packet (the `rawHex` captured by the
 * companion `LogRxData` push and shown in the MeshCore Packet Monitor).
 *
 * Mirrors the wire parsing in `@liamcottle/meshcore.js` (`Packet.fromBytes` /
 * `Advert.fromBytes`) but reimplemented dependency-free (Uint8Array + DataView)
 * so it runs in the browser and is unit-testable. It decodes everything that is
 * unencrypted:
 *   - header (route type, payload type, version)
 *   - transport codes (TRANSPORT_* routes)
 *   - path (hash width + hop count + per-hop relay hashes)
 *   - payload structure, with full ADVERT decode (pubkey, timestamp, signature,
 *     flags, lat/lon, name) and the plaintext dest/src hashes of encrypted
 *     message payloads.
 *
 * Encrypted payload bodies (TXT_MSG/REQ/RESPONSE/etc. ciphertext) cannot be
 * decoded here — we surface the plaintext header bytes and the raw hex.
 */

// ── Constants (kept in sync with meshcore.js Packet / Advert) ───────────────

export const MESHCORE_PAYLOAD_TYPES: { value: number; label: string }[] = [
  { value: 0x00, label: 'REQ' },
  { value: 0x01, label: 'RESPONSE' },
  { value: 0x02, label: 'TXT_MSG' },
  { value: 0x03, label: 'ACK' },
  { value: 0x04, label: 'ADVERT' },
  { value: 0x05, label: 'GRP_TXT' },
  { value: 0x06, label: 'GRP_DATA' },
  { value: 0x07, label: 'ANON_REQ' },
  { value: 0x08, label: 'PATH' },
  { value: 0x09, label: 'TRACE' },
  { value: 0x0a, label: 'MULTIPART' },
  { value: 0x0b, label: 'CONTROL' },
  { value: 0x0f, label: 'RAW_CUSTOM' },
];

export const MESHCORE_ROUTE_TYPES: { value: number; label: string }[] = [
  { value: 0x00, label: 'TRANSPORT_FLOOD' },
  { value: 0x01, label: 'FLOOD' },
  { value: 0x02, label: 'DIRECT' },
  { value: 0x03, label: 'TRANSPORT_DIRECT' },
];

const PAYLOAD_TYPE_NAME: Record<number, string> = Object.fromEntries(
  MESHCORE_PAYLOAD_TYPES.map((t) => [t.value, t.label])
);
const ROUTE_TYPE_NAME: Record<number, string> = Object.fromEntries(
  MESHCORE_ROUTE_TYPES.map((t) => [t.value, t.label])
);

/**
 * CONTROL sub-types (upper nibble of the payload's first byte). Only the
 * node-discovery pair is defined in the firmware today; the rest of the space
 * is unallocated, so an unknown sub-type renders as hex.
 */
const CONTROL_SUB_TYPE_NAME: Record<number, string> = {
  0x80: 'NODE_DISCOVER_REQ',
  0x90: 'NODE_DISCOVER_RESP',
};

const ADV_TYPE_NAME: Record<number, string> = {
  0: 'NONE',
  1: 'CHAT',
  2: 'REPEATER',
  3: 'ROOM',
  4: 'SENSOR',
};

// Payload type values that carry a plaintext (dest_hash, src_hash) prefix
// followed by an encrypted body.
const ENCRYPTED_MSG_TYPES = new Set([0x00, 0x01, 0x02, 0x05, 0x06, 0x07]); // REQ, RESPONSE, TXT_MSG, GRP_TXT, GRP_DATA, ANON_REQ

export function meshcorePayloadTypeName(value: number): string {
  return PAYLOAD_TYPE_NAME[value] ?? `0x${value.toString(16).padStart(2, '0')}`;
}
/**
 * The name of a payload type, or null when the value is not one we know.
 *
 * For ingest paths that store the name: `meshcore.js` names only the types it
 * knew when it was published (nothing above TRACE, plus RAW_CUSTOM) and
 * returns null for the rest, so a MULTIPART or CONTROL packet captured over a
 * direct radio link lands in the packet log unnamed. Callers fall back to this
 * and keep null for a genuinely unknown type rather than storing a hex string
 * that reads like a name.
 */
export function meshcorePayloadTypeNameOrNull(value: number): string | null {
  return PAYLOAD_TYPE_NAME[value] ?? null;
}
export function meshcoreRouteTypeName(value: number | undefined | null): string {
  if (typeof value !== 'number') return '—';
  return ROUTE_TYPE_NAME[value] ?? `0x${value.toString(16).padStart(2, '0')}`;
}

// ── Decoded shapes ──────────────────────────────────────────────────────────

export interface DecodedAdvert {
  publicKey: string;       // 64 hex chars (32 bytes)
  timestamp: number;       // unix seconds
  timestampIso: string | null;
  signature: string;       // 128 hex chars (64 bytes)
  advType: number;
  advTypeName: string;
  flags: number;
  latitude?: number;       // degrees
  longitude?: number;      // degrees
  feat1?: number;
  feat2?: number;
  name?: string;
  /**
   * The raw appData slice (everything after the 100-byte
   * pubkey+timestamp+signature prefix), lowercase hex.
   *
   * Exposed because `Ed25519SignatureVerifier.verifyAdvertisementSignature()`
   * signs over `publicKey + timestamp + appData` and needs those bytes
   * verbatim — the parsed `flags`/`latitude`/`name` above cannot be
   * re-serialised back to them reliably (optional fields, unknown future
   * flags). Keeping it here means ONE decoder serves both the packet-monitor
   * display and any caller that wants to check the signature (#5040 Phase 3).
   *
   * NOTE the ingest path deliberately does NOT gate node creation on signature
   * validity — see the manager's advert handler for that decision.
   */
  appDataHex?: string;
}

/**
 * GRP_TXT (channel message) plaintext framing (#5040 Phase 4).
 *
 * A channel message is NOT laid out like the other encrypted types. The generic
 * branch reads byte 0 as `destHash` and byte 1 as `srcHash`, but for GRP_TXT:
 *
 *   byte 0      channel hash  (first byte of SHA256(channel secret))
 *   bytes 1..2  cipher MAC    (2 bytes)
 *   bytes 3..   ciphertext
 *
 * So byte 1 is half a MAC, not a source hash, and `encryptedHex` from the
 * generic branch starts one byte too early to feed a decrypt. Decoding it
 * properly here keeps ONE decoder for both the packet monitor and the ingest
 * path rather than re-slicing raw bytes at the call site.
 */
export interface DecodedGroupText {
  /** Selects the channel: matches `ChannelCrypto.calculateChannelHash(secret)`. */
  channelHash: string;
  cipherMacHex: string;
  ciphertextHex: string;
}

/**
 * MULTIPART (0x0A) framing, from the firmware's own writer/reader
 * (`Mesh::createMultiAck` and the `PAYLOAD_TYPE_MULTIPART` case in
 * `Mesh::onRecvPacket`):
 *
 *   byte 0     `remaining << 4 | inner_payload_type`
 *   bytes 1..  the inner payload, laid out for `innerType`
 *
 * `remaining` counts the packets of this sequence still to come, so 0 marks
 * the last one. The firmware only ever writes and reads an inner ACK today;
 * any other inner type is surfaced as hex rather than guessed at.
 */
export interface DecodedMultipart {
  /** Packets of this sequence still to be sent; 0 = last part. */
  remaining: number;
  innerType: number;
  innerTypeName: string;
  innerHex: string;
  /** Present when `innerType` is ACK (0x03) and 4 bytes are available. */
  ack?: { ackCodeHex: string };
}

/**
 * CONTROL (0x0B) framing. The public docs give only the first byte ("upper 4
 * bits is sub_type", the rest "typically unencrypted data"), so the field
 * layouts below come from the firmware's node-discovery exchange — the same
 * one MeshMonitor already speaks in `meshcoreNativeBackend` (#1027, #4516):
 *
 *   REQ  (0x80): [0] sub_type|prefix_only, [1] type filter bitmask,
 *                [2..5] tag (uint32 LE), [6..9] optional `since`
 *   RESP (0x90): [0] sub_type|node_type, [1] SNR of the request as the
 *                responder heard it (int8, quarter-dB), [2..5] echoed tag,
 *                [6..] public key (32 bytes, or 8 when prefix_only was asked)
 *
 * The lower nibble means different things per sub-type, so it is exposed raw
 * as well as interpreted.
 */
export interface DecodedControl {
  /** The whole first byte. */
  flags: number;
  /** Upper nibble, e.g. 0x80 = node-discovery request. */
  subType: number;
  subTypeName: string;
  /** Lower nibble of `flags`, whose meaning depends on the sub-type. */
  subFlags: number;
  dataHex: string;
  /** Present for a node-discovery request (0x80). */
  discoverRequest?: {
    /** Responders return only an 8-byte key prefix. */
    prefixOnly: boolean;
    /** Bitmask of `1 << advType` selecting which node types answer. */
    filter: number;
    tag: number;
  };
  /** Present for a node-discovery response (0x90). */
  discoverResponse?: {
    advType: number;
    advTypeName: string;
    /** How the responder heard the request, in dB. */
    snr: number;
    tag: number;
    /** 32 bytes, or 8 when the request asked for a prefix only. */
    publicKey: string;
  };
}

export interface DecodedMeshCorePacket {
  header: {
    raw: number;
    routeType: number;
    routeTypeName: string;
    payloadType: number;
    payloadTypeName: string;
    payloadVersion: number;
  };
  transportCodes?: { code1: number; code2: number };
  path: {
    rawLen: number | null;
    direct: boolean;
    hashSize: number;       // bytes per relay hash
    hopCount: number;
    hops: string[];         // per-hop relay hash, hex
  };
  payload: {
    sizeBytes: number;
    hex: string;
    advert?: DecodedAdvert;
    /** Present for GRP_TXT (0x05) only — see DecodedGroupText. */
    groupText?: DecodedGroupText;
    message?: { destHash: string; srcHash: string; encryptedHex: string };
    ack?: { ackCodeHex: string };
    /** Present for MULTIPART (0x0A) only — see DecodedMultipart. */
    multipart?: DecodedMultipart;
    /** Present for CONTROL (0x0B) only — see DecodedControl. */
    control?: DecodedControl;
  };
  totalBytes: number;
  errors: string[];
}

// ── Byte helpers ────────────────────────────────────────────────────────────

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().replace(/[^0-9a-fA-F]/g, '');
  const len = Math.floor(clean.length / 2);
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

// ── Decoder ─────────────────────────────────────────────────────────────────

/**
 * Decode a MeshCore OTA packet from its raw hex. Always returns a structured
 * result; parse problems are collected in `.errors` rather than thrown, so the
 * UI can render whatever was decodable.
 */
export function decodeMeshCorePacket(rawHex: string | null | undefined): DecodedMeshCorePacket | null {
  if (!rawHex || rawHex.trim() === '') return null;
  const bytes = hexToBytes(rawHex);
  const errors: string[] = [];

  if (bytes.length < 1) {
    return null;
  }

  let offset = 0;
  const header = bytes[offset++];
  const routeType = header & 0x03;
  const payloadType = (header >> 2) & 0x0f;
  const payloadVersion = (header >> 6) & 0x03;

  // Transport codes (TRANSPORT_FLOOD / TRANSPORT_DIRECT): two UInt16LE.
  let transportCodes: { code1: number; code2: number } | undefined;
  const hasTransportCodes = routeType === 0x00 || routeType === 0x03;
  if (hasTransportCodes) {
    if (offset + 4 <= bytes.length) {
      const view = new DataView(bytes.buffer, bytes.byteOffset);
      transportCodes = {
        code1: view.getUint16(offset, true),
        code2: view.getUint16(offset + 2, true),
      };
      offset += 4;
    } else {
      errors.push('truncated before transport codes');
    }
  }

  // Path length byte + path hashes.
  let rawLen: number | null = null;
  let direct = false;
  let hashSize = 0;
  let hopCount = 0;
  const hops: string[] = [];
  if (offset < bytes.length) {
    rawLen = bytes[offset++];
    if (rawLen === 0xff) {
      direct = true; // no relay hashes
    } else {
      hashSize = (rawLen >> 6) + 1;       // top 2 bits: 1/2/3-byte hash width
      hopCount = rawLen & 0x3f;           // bottom 6 bits: hop count
      const pathByteLength = hopCount * hashSize;
      for (let i = 0; i < hopCount; i++) {
        const start = offset + i * hashSize;
        const slice = bytes.subarray(start, start + hashSize);
        if (slice.length < hashSize) {
          errors.push('truncated path hashes');
          break;
        }
        hops.push(bytesToHex(slice));
      }
      offset += pathByteLength;
      if (offset > bytes.length) {
        offset = bytes.length;
      }
    }
  } else {
    errors.push('truncated before path length');
  }

  // Remaining bytes = payload.
  const payloadBytes = bytes.subarray(Math.min(offset, bytes.length));
  const payload: DecodedMeshCorePacket['payload'] = {
    sizeBytes: payloadBytes.length,
    hex: bytesToHex(payloadBytes),
  };

  if (payloadType === 0x04) {
    // ADVERT — fully decodable (unencrypted).
    const advert = decodeAdvert(payloadBytes, errors);
    if (advert) payload.advert = advert;
  } else if (payloadType === 0x03) {
    // ACK — entire payload is the ack code.
    payload.ack = { ackCodeHex: bytesToHex(payloadBytes) };
  } else if (payloadType === 0x05) {
    // GRP_TXT: channel_hash(1) | cipher_mac(2) | ciphertext(rest).
    if (payloadBytes.length >= 4) {
      payload.groupText = {
        channelHash: payloadBytes[0].toString(16).padStart(2, '0'),
        cipherMacHex: bytesToHex(payloadBytes.subarray(1, 3)),
        ciphertextHex: bytesToHex(payloadBytes.subarray(3)),
      };
    } else {
      errors.push('GRP_TXT payload too short to decode');
    }
    // Also fill the generic shape so the monitor's existing rendering is
    // unchanged; only the new `groupText` field is layout-correct for decrypt.
    if (payloadBytes.length >= 2) {
      payload.message = {
        destHash: payloadBytes[0].toString(16).padStart(2, '0'),
        srcHash: payloadBytes[1].toString(16).padStart(2, '0'),
        encryptedHex: bytesToHex(payloadBytes.subarray(2)),
      };
    }
  } else if (payloadType === 0x0a) {
    // MULTIPART — part of a sequence; the first byte wraps an inner payload.
    const multipart = decodeMultipart(payloadBytes, errors);
    if (multipart) payload.multipart = multipart;
  } else if (payloadType === 0x0b) {
    // CONTROL — unencrypted control/discovery data.
    const control = decodeControl(payloadBytes, errors);
    if (control) payload.control = control;
  } else if (ENCRYPTED_MSG_TYPES.has(payloadType)) {
    // Plaintext (dest_hash, src_hash) prefix; the rest is encrypted.
    if (payloadBytes.length >= 2) {
      payload.message = {
        destHash: payloadBytes[0].toString(16).padStart(2, '0'),
        srcHash: payloadBytes[1].toString(16).padStart(2, '0'),
        encryptedHex: bytesToHex(payloadBytes.subarray(2)),
      };
    }
  }

  return {
    header: {
      raw: header,
      routeType,
      routeTypeName: meshcoreRouteTypeName(routeType),
      payloadType,
      payloadTypeName: meshcorePayloadTypeName(payloadType),
      payloadVersion,
    },
    transportCodes,
    path: { rawLen, direct, hashSize, hopCount, hops },
    payload,
    totalBytes: bytes.length,
    errors,
  };
}

function decodeMultipart(payload: Uint8Array, errors: string[]): DecodedMultipart | undefined {
  // The firmware itself ignores a multipart payload of 2 bytes or fewer, so
  // there is nothing to read past the wrapper byte.
  if (payload.length < 1) {
    errors.push('MULTIPART payload too short to decode');
    return undefined;
  }
  const first = payload[0];
  const innerType = first & 0x0f;
  const innerBytes = payload.subarray(1);
  const out: DecodedMultipart = {
    remaining: first >> 4,
    innerType,
    innerTypeName: meshcorePayloadTypeName(innerType),
    innerHex: bytesToHex(innerBytes),
  };
  if (innerType === 0x03) {
    // Inner ACK — 4-byte CRC, the one inner type the firmware handles.
    if (innerBytes.length >= 4) {
      out.ack = { ackCodeHex: bytesToHex(innerBytes.subarray(0, 4)) };
    } else {
      errors.push('MULTIPART ACK payload too short to decode');
    }
  }
  return out;
}

function decodeControl(payload: Uint8Array, errors: string[]): DecodedControl | undefined {
  if (payload.length < 1) {
    errors.push('CONTROL payload too short to decode');
    return undefined;
  }
  const flags = payload[0];
  const subType = flags & 0xf0;
  const body = payload.subarray(1);
  const out: DecodedControl = {
    flags,
    subType,
    subTypeName:
      CONTROL_SUB_TYPE_NAME[subType] ?? `0x${subType.toString(16).padStart(2, '0')}`,
    subFlags: flags & 0x0f,
    dataHex: bytesToHex(body),
  };

  if (subType === 0x80) {
    // [filter][tag(4 LE)] — `since` (4 more) is optional and unused here.
    if (body.length >= 5) {
      out.discoverRequest = {
        prefixOnly: (flags & 0x01) !== 0,
        filter: body[0],
        tag: readUint32LE(body, 1),
      };
    } else {
      errors.push('CONTROL NODE_DISCOVER_REQ payload too short to decode');
    }
  } else if (subType === 0x90) {
    // [snr(int8)][tag(4 LE)][pubkey(8 or 32)]
    if (body.length >= 5) {
      const advType = flags & 0x0f;
      out.discoverResponse = {
        advType,
        advTypeName: ADV_TYPE_NAME[advType] ?? `0x${advType.toString(16)}`,
        snr: ((body[0] << 24) >> 24) / 4,
        tag: readUint32LE(body, 1),
        publicKey: bytesToHex(body.subarray(5)),
      };
    } else {
      errors.push('CONTROL NODE_DISCOVER_RESP payload too short to decode');
    }
  }
  return out;
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>> 0
  );
}

function decodeAdvert(payload: Uint8Array, errors: string[]): DecodedAdvert | undefined {
  // pubkey(32) + timestamp(4 LE) + signature(64) + appData(var)
  if (payload.length < 100) {
    errors.push('ADVERT payload too short to decode');
    return undefined;
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const publicKey = bytesToHex(payload.subarray(0, 32));
  const timestamp = view.getUint32(32, true);
  const signature = bytesToHex(payload.subarray(36, 100));

  const advert: DecodedAdvert = {
    publicKey,
    timestamp,
    timestampIso: timestamp > 0 ? new Date(timestamp * 1000).toISOString() : null,
    signature,
    advType: 0,
    advTypeName: ADV_TYPE_NAME[0],
    flags: 0,
  };

  // appData: flags byte, then optional fields. Captured whole first, since the
  // signature is computed over these exact bytes.
  advert.appDataHex = bytesToHex(payload.subarray(100));
  let p = 100;
  if (p < payload.length) {
    const flags = payload[p++];
    advert.flags = flags;
    advert.advType = flags & 0x0f;
    advert.advTypeName = ADV_TYPE_NAME[advert.advType] ?? `0x${advert.advType.toString(16)}`;

    if (flags & 0x10) {
      // lat/lon: Int32LE in units of 1e-6 degrees
      if (p + 8 <= payload.length) {
        advert.latitude = view.getInt32(p, true) / 1_000_000;
        advert.longitude = view.getInt32(p + 4, true) / 1_000_000;
        p += 8;
      } else {
        errors.push('truncated ADVERT lat/lon');
      }
    }
    if (flags & 0x20) {
      if (p + 2 <= payload.length) {
        advert.feat1 = view.getUint16(p, true);
        p += 2;
      } else {
        errors.push('truncated ADVERT feat1');
      }
    }
    if (flags & 0x40) {
      if (p + 2 <= payload.length) {
        advert.feat2 = view.getUint16(p, true);
        p += 2;
      } else {
        errors.push('truncated ADVERT feat2');
      }
    }
    if (flags & 0x80) {
      // Name: remaining bytes up to a null terminator, UTF-8.
      const rest = payload.subarray(p);
      let end = rest.indexOf(0);
      if (end < 0) end = rest.length;
      try {
        advert.name = new TextDecoder('utf-8', { fatal: false }).decode(rest.subarray(0, end));
      } catch {
        advert.name = bytesToHex(rest.subarray(0, end));
      }
    }
  }

  return advert;
}
