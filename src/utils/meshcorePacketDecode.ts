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
    message?: { destHash: string; srcHash: string; encryptedHex: string };
    ack?: { ackCodeHex: string };
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

  // appData: flags byte, then optional fields.
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
