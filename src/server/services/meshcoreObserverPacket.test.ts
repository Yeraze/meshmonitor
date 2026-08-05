/**
 * Golden tests for the MeshCore Analyzer Observer packet/status encoder
 * (#4457 Phase 2, WP1). See `docs/internal/dev-notes/MESHCORE_OBSERVER_PHASE2_SPEC.md`
 * §2 (wire contract) and §7.1 (this test plan).
 *
 * Fixture provenance note: `src/server/meshcoreNativeBackend.otaPacket.test.ts`
 * builds its `raw_hex` fixtures against a *mock* `Packet.fromBytes` that lays
 * bytes out as `[payload_type, route_type, pathLen, ...path]` — a test-mock
 * convenience for that file, NOT the real firmware wire encoding (real header
 * byte = `(version<<6)|(payloadType<<2)|routeType`). Reusing those bytes here
 * would exercise the wrong header bit-packing. Frame *bytes* below are instead
 * built with the same real-encoding `Builder`/`header()` helper used by
 * `src/utils/meshcorePacketDecode.test.ts` (several frames below are the exact
 * same fixtures, byte for byte, enabling the §1.7 cross-check). Where the
 * otaPacket fixtures' SNR/RSSI *values* line up with a scenario here, those
 * numeric values are reused directly.
 *
 * Timezone discipline (spec §7.1): `time`/`date` come from LOCAL Date getters;
 * `timestamp` is UTC (`toISOString()`, D-8) and is always a hardcoded literal.
 * Whole-object goldens derive the expected `time`/`date` from the SAME fixed
 * `Date` via its own local getters — never hardcode them, and never set
 * `process.env.TZ` in this file (a UTC-getter regression must fail on every
 * non-UTC operator, not be hidden by a pinned zone).
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { decodeMeshCorePacket } from '../../utils/meshcorePacketDecode.js';
import {
  pathByteLength,
  parseObserverFrame,
  calculateMeshCorePacketHash,
  buildObserverPacketPayload,
  buildObserverStatusPayload,
  buildObserverDeviceStats,
  observerTopics,
  type ObserverPacketIdentity,
} from './meshcoreObserverPacket.js';
import type { OtaPacketEvent } from '../meshcoreVirtualNodeServer.js';

// ── Frame builder (mirrors src/utils/meshcorePacketDecode.test.ts's Builder —
//    real wire-format header bit-packing, not the native-backend test mock) ──
class Builder {
  private parts: number[] = [];
  u8(v: number) {
    this.parts.push(v & 0xff);
    return this;
  }
  u16le(v: number) {
    this.parts.push(v & 0xff, (v >> 8) & 0xff);
    return this;
  }
  bytes(arr: number[]) {
    this.parts.push(...arr.map((x) => x & 0xff));
    return this;
  }
  fill(n: number, v = 0) {
    for (let i = 0; i < n; i++) this.parts.push(v & 0xff);
    return this;
  }
  hex(): string {
    return this.parts.map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  array(): number[] {
    return this.parts.slice();
  }
}

const header = (route: number, payload: number, version = 0) =>
  ((version & 0x03) << 6) | ((payload & 0x0f) << 2) | (route & 0x03);

/** Independent reference implementation of §2.3.2's hash pseudocode, for cross-checking. */
function referenceHash(payloadType: number, pathLenRaw: number, payload: number[]): string {
  const sha = createHash('sha256');
  sha.update(Buffer.from([payloadType]));
  if (payloadType === 0x09) {
    const le = Buffer.alloc(2);
    le.writeUInt16LE(pathLenRaw & 0xffff, 0);
    sha.update(le);
  }
  sha.update(Buffer.from(payload));
  return sha.digest('hex').slice(0, 16).toUpperCase();
}

const IDENTITY: ObserverPacketIdentity = {
  origin: 'TestNode',
  // 64 hex chars, uppercase, by construction.
  originId: 'AB'.repeat(32),
};

function toEvent(rawHex: string, snr?: number | null, rssi?: number | null): OtaPacketEvent {
  return { raw_hex: rawHex, snr, rssi };
}

describe('pathByteLength', () => {
  it('returns 0 for the direct sentinel 0xff', () => {
    expect(pathByteLength(0xff)).toBe(0);
  });

  it('agrees with a plain byte-count read for every path_len_raw <= 0x3f', () => {
    for (let b = 0; b <= 0x3f; b++) {
      expect(pathByteLength(b)).toBe(b);
    }
  });

  it('decodes packed hash-size/hop-count above 0x3f', () => {
    // 0x81 = 0b1000_0001 -> hashSize=(2)+1=3, hopCount=1 -> 3*1=3
    expect(pathByteLength(0x81)).toBe(3);
    // 0x42 = 0b0100_0010 -> hashSize=(1)+1=2, hopCount=2 -> 2*2=4
    expect(pathByteLength(0x42)).toBe(4);
  });
});

describe('parseObserverFrame — ok:false paths', () => {
  it('empty input', () => {
    const p = parseObserverFrame('');
    expect(p.ok).toBe(false);
    expect(p.totalBytes).toBe(0);
  });

  it('1-byte frame (fewer than 2 bytes)', () => {
    const p = parseObserverFrame('00');
    expect(p.ok).toBe(false);
    expect(p.totalBytes).toBe(1);
  });

  it('truncated before/inside transport codes', () => {
    // TRANSPORT_FLOOD (route 0x00) needs 4 transport bytes; only 2 supplied.
    const hex = new Builder().u8(header(0x00, 0x02)).bytes([0x01, 0x02]).hex();
    const p = parseObserverFrame(hex);
    expect(p.ok).toBe(false);
  });

  it('truncated before path_len (transport codes present, nothing after)', () => {
    const hex = new Builder().u8(header(0x00, 0x02)).u16le(0).u16le(0).hex();
    const p = parseObserverFrame(hex);
    expect(p.ok).toBe(false);
    expect(p.totalBytes).toBe(5);
  });

  it('truncated path hashes (mirrors decodeMeshCorePacket.test.ts truncation fixture)', () => {
    // Claims 3 hops of 1-byte hashes but provides none — identical bytes to
    // decodeMeshCorePacket.test.ts's "does not throw on a truncated packet" fixture.
    const hex = new Builder().u8(header(0x01, 0x02)).u8(0x03).hex();
    const p = parseObserverFrame(hex);
    expect(p.ok).toBe(false);
  });

  it('payloadVersion !== 0 (VER_1-only gate)', () => {
    // Identical bytes to decodeMeshCorePacket.test.ts's header-bitfield fixture.
    const hex = new Builder().u8(header(0x01, 0x02, 1)).u8(0xff).hex();
    const p = parseObserverFrame(hex);
    expect(p.ok).toBe(false);
    // But structural fields are still fully populated.
    expect(p.payloadType).toBe(0x02);
    expect(p.routeType).toBe(0x01);
    expect(p.hopCount).toBe(0);
    expect(p.payloadStart).toBe(2);
    expect(p.payloadLen).toBe(0);
  });

  it('reserved hashSize === 4 (bits 7:6 = 11)', () => {
    // pathLenRaw 0xC1 -> hashSize=4 (reserved), hopCount=1.
    const hex = new Builder()
      .u8(header(0x01, 0x02))
      .u8(0xc1)
      .bytes([0x01, 0x02, 0x03, 0x04]) // 1 hop * 4-byte hash
      .u8(0x99) // 1 payload byte
      .hex();
    const p = parseObserverFrame(hex);
    expect(p.ok).toBe(false);
    expect(p.hashSize).toBe(4);
    expect(p.hopCount).toBe(1);
    expect(p.payloadLen).toBe(1);
  });
});

describe('parseObserverFrame — D-3 packed vs. plain divergence (named test)', () => {
  it('path_len_raw = 0x81 uses the packed decode, not a plain byte count', () => {
    // header: DIRECT (0x02) + TXT_MSG (0x02); pathLenRaw=0x81 -> hashSize=3, hopCount=1.
    const hex = new Builder()
      .u8(header(0x02, 0x02))
      .u8(0x81)
      .bytes([0xaa, 0xbb, 0xcc]) // 1 hop * 3-byte hash (packed decode)
      .bytes([0x11, 0x22, 0x33]) // payload
      .hex();

    const p = parseObserverFrame(hex);
    expect(p.ok).toBe(true);
    expect(p.hashSize).toBe(3);
    expect(p.hopCount).toBe(1);
    expect(p.hops).toEqual(['aabbcc']);
    expect(p.payloadStart).toBe(5); // 1 (header) + 1 (pathlen) + 3 (packed path bytes)
    expect(p.payloadLen).toBe(3);

    // Our hash: SHA-256([payload_type] + the 3-byte packed-decode payload).
    const ourHash = calculateMeshCorePacketHash(hex);
    expect(ourHash).toBe(referenceHash(0x02, 0x81, [0x11, 0x22, 0x33]));

    // The Python reference's plain byte-count read would treat 0x81 (=129
    // decimal) as a literal path length of 129 bytes. This 8-byte frame has
    // only 3 bytes left after the path_len byte, so a plain read consumes
    // everything remaining as "path" and is left with an EMPTY payload —
    // a different, wrong hash input. This is the named D-3 divergence: the
    // two decodes agree only for path_len_raw <= 0x3f (see the
    // `pathByteLength` suite above).
    const plainReferenceHash = referenceHash(0x02, 0x81, []);
    expect(ourHash).not.toBe(plainReferenceHash);
  });
});

describe('parseObserverFrame — cross-check vs. decodeMeshCorePacket (§1.7)', () => {
  const fixtures: { name: string; hex: string }[] = [
    {
      name: 'FLOOD TXT_MSG',
      hex: new Builder()
        .u8(header(0x01, 0x02))
        .u8(0x02) // hashSize1, hopCount2
        .bytes([0xa3, 0x7f])
        .bytes([0x12, 0x34, 0xde, 0xad, 0xbe, 0xef])
        .hex(),
    },
    {
      name: 'DIRECT with hops',
      hex: new Builder()
        .u8(header(0x02, 0x05))
        .u8(0x42) // hashSize2, hopCount2
        .bytes([0xaa, 0xbb, 0xcc, 0xdd])
        .bytes([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02])
        .hex(),
    },
    {
      name: 'TRANSPORT_FLOOD',
      hex: new Builder()
        .u8(header(0x00, 0x02))
        .u16le(0x1234)
        .u16le(0xabcd)
        .u8(0x01) // hashSize1, hopCount1
        .bytes([0x5a])
        .bytes([0x12, 0x34, 0xca, 0xfe])
        .hex(),
    },
    {
      name: 'TRANSPORT_DIRECT',
      hex: new Builder()
        .u8(header(0x03, 0x03))
        .u16le(0x0001)
        .u16le(0x0002)
        .u8(0x02) // hashSize1, hopCount2
        .bytes([0x11, 0x22])
        .bytes([0x99, 0x88])
        .hex(),
    },
    {
      name: 'ADVERT (direct, no hops)',
      hex: new Builder()
        .u8(header(0x02, 0x04))
        .u8(0xff)
        .fill(32, 0x01) // pubkey
        .fill(4, 0x00) // timestamp
        .fill(64, 0x02) // signature
        .u8(0x00) // flags: no lat/lon/name
        .hex(),
    },
    {
      name: 'payloadVersion !== 0 (still cross-checkable)',
      hex: new Builder().u8(header(0x01, 0x02, 1)).u8(0xff).hex(),
    },
  ];

  it.each(fixtures)('agrees with decodeMeshCorePacket on $name', ({ hex }) => {
    const ours = parseObserverFrame(hex);
    const theirs = decodeMeshCorePacket(hex)!;
    expect(theirs).not.toBeNull();
    expect(ours.payloadType).toBe(theirs.header.payloadType);
    expect(ours.routeType).toBe(theirs.header.routeType);
    expect(ours.hopCount).toBe(theirs.path.hopCount);
    expect(ours.payloadLen).toBe(theirs.payload.sizeBytes);
  });
});

describe('calculateMeshCorePacketHash', () => {
  it('matches a hand-computed SHA-256 over [payload_type] + payload', () => {
    // FLOOD + TXT_MSG, direct (no hops), payload = [0xAA, 0xBB, 0xCC].
    const hex = new Builder().u8(header(0x01, 0x02)).u8(0xff).bytes([0xaa, 0xbb, 0xcc]).hex();

    const expected = createHash('sha256')
      .update(Buffer.from([0x02, 0xaa, 0xbb, 0xcc])) // [payload_type] + payload, spelled out
      .digest('hex')
      .slice(0, 16)
      .toUpperCase();

    expect(calculateMeshCorePacketHash(hex)).toBe(expected);
  });

  it('TRACE (payload_type 9) includes uint16le(path_len_raw) as a hash prefix', () => {
    // FLOOD + TRACE, pathLenRaw=0x03 (hashSize1, hopCount3).
    const hex = new Builder()
      .u8(header(0x01, 0x09))
      .u8(0x03)
      .bytes([0x01, 0x02, 0x03])
      .bytes([0x55, 0x66])
      .hex();

    const withPrefix = calculateMeshCorePacketHash(hex);

    const withoutPrefix = createHash('sha256')
      .update(Buffer.from([0x09, 0x55, 0x66])) // no path_len_raw prefix
      .digest('hex')
      .slice(0, 16)
      .toUpperCase();

    expect(withPrefix).not.toBe(withoutPrefix);
  });

  it('returns the sentinel for empty, invalid-hex, and 1-byte input', () => {
    expect(calculateMeshCorePacketHash('')).toBe('0000000000000000');
    expect(calculateMeshCorePacketHash('zz')).toBe('0000000000000000');
    expect(calculateMeshCorePacketHash('00')).toBe('0000000000000000');
  });

  it('is 16 uppercase hex chars', () => {
    const hex = new Builder().u8(header(0x01, 0x02)).u8(0xff).bytes([0x01]).hex();
    expect(calculateMeshCorePacketHash(hex)).toMatch(/^[0-9A-F]{16}$/);
  });
});

describe('buildObserverPacketPayload — full-payload goldens', () => {
  // Fixed `now` shared by every golden. `timestamp` (UTC, D-8) is always a
  // hardcoded literal; `time`/`date` (local) are derived from this SAME Date
  // via its own local getters, per the timezone-discipline callout above.
  const now = new Date('2026-07-31T14:30:05.123Z');
  const expectedTimestamp = '2026-07-31T14:30:05.123Z';
  const expectedTime = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
  const expectedDate = [
    String(now.getDate()).padStart(2, '0'),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getFullYear()),
  ].join('/');

  it('FLOOD TXT_MSG', () => {
    const rawBytes = [0x12, 0x34, 0xde, 0xad, 0xbe, 0xef];
    const hex = new Builder().u8(header(0x01, 0x02)).u8(0x02).bytes([0xa3, 0x7f]).bytes(rawBytes).hex();
    const payload = buildObserverPacketPayload(toEvent(hex, 6.25, -42), IDENTITY, now);

    expect(payload).toEqual({
      origin: IDENTITY.origin,
      origin_id: IDENTITY.originId,
      timestamp: expectedTimestamp,
      type: 'PACKET',
      direction: 'rx',
      time: expectedTime,
      date: expectedDate,
      len: '10',
      packet_type: '2',
      route: 'F',
      payload_len: '6',
      raw: hex.toUpperCase(),
      SNR: '6.25',
      RSSI: '-42',
      hash: referenceHash(0x02, 0x02, rawBytes),
    });
  });

  it('DIRECT (with hops)', () => {
    const rawBytes = [0xde, 0xad, 0xbe, 0xef, 0x01, 0x02];
    const hex = new Builder()
      .u8(header(0x02, 0x05))
      .u8(0x42)
      .bytes([0xaa, 0xbb, 0xcc, 0xdd])
      .bytes(rawBytes)
      .hex();
    const payload = buildObserverPacketPayload(toEvent(hex, -3.5, -88), IDENTITY, now);

    expect(payload).toEqual({
      origin: IDENTITY.origin,
      origin_id: IDENTITY.originId,
      timestamp: expectedTimestamp,
      type: 'PACKET',
      direction: 'rx',
      time: expectedTime,
      date: expectedDate,
      len: '12',
      packet_type: '5',
      route: 'D',
      payload_len: '6',
      raw: hex.toUpperCase(),
      SNR: '-3.5',
      RSSI: '-88',
      hash: referenceHash(0x05, 0x42, rawBytes),
      path: 'aabb,ccdd',
    });
  });

  it('TRANSPORT_FLOOD', () => {
    const rawBytes = [0x12, 0x34, 0xca, 0xfe];
    const hex = new Builder()
      .u8(header(0x00, 0x02))
      .u16le(0x1234)
      .u16le(0xabcd)
      .u8(0x01)
      .bytes([0x5a])
      .bytes(rawBytes)
      .hex();
    const payload = buildObserverPacketPayload(toEvent(hex, undefined, -70), IDENTITY, now);

    expect(payload).toEqual({
      origin: IDENTITY.origin,
      origin_id: IDENTITY.originId,
      timestamp: expectedTimestamp,
      type: 'PACKET',
      direction: 'rx',
      time: expectedTime,
      date: expectedDate,
      len: '11',
      packet_type: '2',
      route: 'F',
      payload_len: '4',
      raw: hex.toUpperCase(),
      SNR: 'Unknown',
      RSSI: '-70',
      hash: referenceHash(0x02, 0x01, rawBytes),
    });
    expect(payload).not.toHaveProperty('path');
  });

  it('TRANSPORT_DIRECT (maps to "T", never gets a path even with hops)', () => {
    const rawBytes = [0x99, 0x88];
    const hex = new Builder()
      .u8(header(0x03, 0x03))
      .u16le(0x0001)
      .u16le(0x0002)
      .u8(0x02)
      .bytes([0x11, 0x22])
      .bytes(rawBytes)
      .hex();
    const payload = buildObserverPacketPayload(toEvent(hex, 0, -100), IDENTITY, now);

    expect(payload).toEqual({
      origin: IDENTITY.origin,
      origin_id: IDENTITY.originId,
      timestamp: expectedTimestamp,
      type: 'PACKET',
      direction: 'rx',
      time: expectedTime,
      date: expectedDate,
      len: '10',
      packet_type: '3',
      route: 'T',
      payload_len: '2',
      raw: hex.toUpperCase(),
      SNR: '0',
      RSSI: '-100',
      hash: referenceHash(0x03, 0x02, rawBytes),
    });
    expect(payload).not.toHaveProperty('path');
  });

  it('ADVERT (direct, zero hops -> path is present and empty)', () => {
    const advertPayload = new Builder().fill(32, 0x01).fill(4, 0x00).fill(64, 0x02).u8(0x00).array();
    const hex = new Builder().u8(header(0x02, 0x04)).u8(0xff).bytes(advertPayload).hex();
    const payload = buildObserverPacketPayload(toEvent(hex, -1, -90), IDENTITY, now);

    expect(payload).toEqual({
      origin: IDENTITY.origin,
      origin_id: IDENTITY.originId,
      timestamp: expectedTimestamp,
      type: 'PACKET',
      direction: 'rx',
      time: expectedTime,
      date: expectedDate,
      len: String(2 + advertPayload.length),
      packet_type: '4',
      route: 'D',
      payload_len: String(advertPayload.length),
      raw: hex.toUpperCase(),
      SNR: '-1',
      RSSI: '-90',
      hash: referenceHash(0x04, 0xff, advertPayload),
      path: '',
    });
  });
});

describe('buildObserverPacketPayload — format/shape guards', () => {
  const fixedHex = new Builder().u8(header(0x01, 0x02)).u8(0xff).bytes([0x01, 0x02]).hex();

  it('time/date shape matches across all goldens', () => {
    const payload = buildObserverPacketPayload(toEvent(fixedHex), IDENTITY)!;
    expect(payload.time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(payload.date).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
  });

  it('time/date format (TZ-independent, zero-padding + DD/MM regression guard)', () => {
    // Local components: 5 Jul 2026, 09:04:03 local time — every field
    // deliberately single digit so the local getters return exactly these
    // values in EVERY timezone (no UTC/local skew possible for this assertion).
    const localNow = new Date(2026, 6, 5, 9, 4, 3);
    const payload = buildObserverPacketPayload(toEvent(fixedHex), IDENTITY, localNow)!;
    expect(payload.time).toBe('09:04:03');
    expect(payload.date).toBe('05/07/2026');
  });

  it('every numeric field is a JSON string (type discipline)', () => {
    const payload = buildObserverPacketPayload(toEvent(fixedHex, 6.25, -42), IDENTITY)!;
    expect(typeof payload.len).toBe('string');
    expect(typeof payload.packet_type).toBe('string');
    expect(typeof payload.payload_len).toBe('string');
    expect(typeof payload.SNR).toBe('string');
    expect(typeof payload.RSSI).toBe('string');
  });

  it('path is present iff route === "D"', () => {
    const direct = new Builder().u8(header(0x02, 0x02)).u8(0xff).bytes([0x01]).hex();
    const flood = new Builder().u8(header(0x01, 0x02)).u8(0xff).bytes([0x01]).hex();

    expect(buildObserverPacketPayload(toEvent(direct), IDENTITY)).toHaveProperty('path');
    expect(buildObserverPacketPayload(toEvent(flood), IDENTITY)).not.toHaveProperty('path');
  });

  it('route map covers all four route types plus the decode-failure "U"', () => {
    const flood = new Builder().u8(header(0x01, 0x02)).u8(0xff).bytes([0x01]).hex();
    const direct = new Builder().u8(header(0x02, 0x02)).u8(0xff).bytes([0x01]).hex();
    const transportFlood = new Builder()
      .u8(header(0x00, 0x02))
      .u16le(0)
      .u16le(0)
      .u8(0xff)
      .bytes([0x01])
      .hex();
    const transportDirect = new Builder()
      .u8(header(0x03, 0x02))
      .u16le(0)
      .u16le(0)
      .u8(0xff)
      .bytes([0x01])
      .hex();
    // Malformed: transport route missing its 4 transport-code bytes entirely.
    const malformed = new Builder().u8(header(0x00, 0x02)).u8(0x01).hex();

    expect(buildObserverPacketPayload(toEvent(flood), IDENTITY)!.route).toBe('F');
    expect(buildObserverPacketPayload(toEvent(direct), IDENTITY)!.route).toBe('D');
    expect(buildObserverPacketPayload(toEvent(transportFlood), IDENTITY)!.route).toBe('F');
    expect(buildObserverPacketPayload(toEvent(transportDirect), IDENTITY)!.route).toBe('T');

    const u = buildObserverPacketPayload(toEvent(malformed), IDENTITY)!;
    expect(u.route).toBe('U');
    expect(u.packet_type).toBe('0');
    expect(u.payload_len).toBe('0');
    expect(u).not.toHaveProperty('path');
    expect(u.hash).toBe('0000000000000000');
  });

  it('SNR/RSSI formatting: 6.25 -> "6.25", -9 -> "-9", 0 -> "0" (not Unknown), undefined/null -> "Unknown"', () => {
    expect(buildObserverPacketPayload(toEvent(fixedHex, 6.25, undefined), IDENTITY)!.SNR).toBe('6.25');
    expect(buildObserverPacketPayload(toEvent(fixedHex, -9, undefined), IDENTITY)!.SNR).toBe('-9');
    expect(buildObserverPacketPayload(toEvent(fixedHex, 0, undefined), IDENTITY)!.SNR).toBe('0');
    expect(buildObserverPacketPayload(toEvent(fixedHex, undefined, undefined), IDENTITY)!.SNR).toBe('Unknown');
    expect(buildObserverPacketPayload(toEvent(fixedHex, null, null), IDENTITY)!.RSSI).toBe('Unknown');
  });

  it('returns null iff raw_hex is missing/blank', () => {
    expect(buildObserverPacketPayload(toEvent(''), IDENTITY)).toBeNull();
    expect(buildObserverPacketPayload(toEvent('   '), IDENTITY)).toBeNull();
    expect(buildObserverPacketPayload({ snr: 1, rssi: 1 }, IDENTITY)).toBeNull();
  });
});

describe('buildObserverStatusPayload', () => {
  const now = new Date('2026-07-31T14:30:05.123Z');

  it('online includes all 8 keys', () => {
    const p = buildObserverStatusPayload(
      'online',
      IDENTITY,
      { model: 'M1', firmwareVersion: 'v1.16.1', radio: '910.0,250,10,5', clientVersion: 'meshmonitor/4.13.3' },
      now,
    );
    expect(Object.keys(p).sort()).toEqual(
      ['client_version', 'firmware_version', 'model', 'origin', 'origin_id', 'radio', 'status', 'timestamp'].sort(),
    );
    expect(p.status).toBe('online');
    expect(p.origin_id).toBe(IDENTITY.originId);
  });

  it('online falls back to "unknown" for absent device fields', () => {
    const p = buildObserverStatusPayload('online', IDENTITY, undefined, now);
    expect(p.model).toBe('unknown');
    expect(p.firmware_version).toBe('unknown');
    expect(p.radio).toBe('unknown');
    expect(p.client_version).toBe('unknown');
  });

  it('offline omits the optional four device keys', () => {
    const p = buildObserverStatusPayload('offline', IDENTITY, undefined, now);
    expect(Object.keys(p).sort()).toEqual(['origin', 'origin_id', 'status', 'timestamp'].sort());
    expect(p.status).toBe('offline');
  });

  it('origin_id is always uppercased', () => {
    const lower: ObserverPacketIdentity = { origin: 'x', originId: IDENTITY.originId.toLowerCase() };
    const p = buildObserverStatusPayload('offline', lower, undefined, now);
    expect(p.origin_id).toBe(IDENTITY.originId);
  });

  // ── device stats (#4556) ────────────────────────────────────────────────

  it('online carries device stats under the snake_case `stats` key', () => {
    const p = buildObserverStatusPayload(
      'online',
      IDENTITY,
      { stats: { batteryMv: 4021, uptimeSecs: 86_400, noiseFloor: -92 } },
      now,
    );
    expect(p.stats).toEqual({ battery_mv: 4021, uptime_secs: 86_400, noise_floor: -92 });
  });

  it('online omits `stats` entirely when no stats are supplied', () => {
    expect(buildObserverStatusPayload('online', IDENTITY, { model: 'M1' }, now)).not.toHaveProperty(
      'stats',
    );
    expect(buildObserverStatusPayload('online', IDENTITY, { stats: null }, now)).not.toHaveProperty(
      'stats',
    );
    expect(buildObserverStatusPayload('online', IDENTITY, { stats: {} }, now)).not.toHaveProperty(
      'stats',
    );
  });

  it('offline never carries stats even when supplied', () => {
    const p = buildObserverStatusPayload('offline', IDENTITY, { stats: { batteryMv: 4021 } }, now);
    expect(p).not.toHaveProperty('stats');
    expect(Object.keys(p).sort()).toEqual(['origin', 'origin_id', 'status', 'timestamp'].sort());
  });
});

describe('buildObserverDeviceStats', () => {
  it('maps every camelCase field onto its analyzer-contract snake_case key', () => {
    expect(
      buildObserverDeviceStats({
        batteryMv: 3980,
        uptimeSecs: 1234,
        errors: 2,
        queueLen: 0,
        noiseFloor: -101,
        txAirSecs: 55,
        rxAirSecs: 900,
      }),
    ).toEqual({
      battery_mv: 3980,
      uptime_secs: 1234,
      errors: 2,
      queue_len: 0,
      noise_floor: -101,
      tx_air_secs: 55,
      rx_air_secs: 900,
    });
  });

  it('omits fields the firmware did not report rather than publishing a placeholder', () => {
    const stats = buildObserverDeviceStats({ batteryMv: 4100, noiseFloor: undefined, errors: null });
    expect(stats).toEqual({ battery_mv: 4100 });
    expect(stats).not.toHaveProperty('noise_floor');
    expect(stats).not.toHaveProperty('errors');
  });

  it('keeps genuine zero and negative readings', () => {
    // A freshly-booted node reports uptime_secs 0, an idle one queue_len 0,
    // and noise_floor is routinely negative — a truthiness filter eats all three.
    expect(buildObserverDeviceStats({ uptimeSecs: 0, queueLen: 0, noiseFloor: -110 })).toEqual({
      uptime_secs: 0,
      queue_len: 0,
      noise_floor: -110,
    });
  });

  it('drops non-finite readings', () => {
    expect(buildObserverDeviceStats({ batteryMv: NaN, uptimeSecs: Infinity })).toBeUndefined();
  });

  it('returns undefined for null/undefined/empty input', () => {
    expect(buildObserverDeviceStats(null)).toBeUndefined();
    expect(buildObserverDeviceStats(undefined)).toBeUndefined();
    expect(buildObserverDeviceStats({})).toBeUndefined();
  });
});

describe('observerTopics', () => {
  it('normalizes the "test" region to lowercase regardless of input case', () => {
    expect(observerTopics('TEST', 'abc').region).toBe('test');
    expect(observerTopics('test', 'abc').region).toBe('test');
  });

  it('uppercases a real IATA code and the public key', () => {
    const t = observerTopics('mco', 'abc123');
    expect(t.region).toBe('MCO');
    expect(t.packets).toBe('meshcore/MCO/ABC123/packets');
    expect(t.status).toBe('meshcore/MCO/ABC123/status');
  });
});
