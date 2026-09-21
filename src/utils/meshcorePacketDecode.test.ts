import { describe, it, expect } from 'vitest';
import { decodeMeshCorePacket, hexToBytes } from './meshcorePacketDecode';

// ── Small builder for constructing OTA packets in tests ──────────────────────
class Builder {
  private parts: number[] = [];
  u8(v: number) { this.parts.push(v & 0xff); return this; }
  u16le(v: number) { this.parts.push(v & 0xff, (v >> 8) & 0xff); return this; }
  i32le(v: number) {
    const b = new ArrayBuffer(4);
    new DataView(b).setInt32(0, v, true);
    this.parts.push(...new Uint8Array(b));
    return this;
  }
  u32le(v: number) {
    const b = new ArrayBuffer(4);
    new DataView(b).setUint32(0, v, true);
    this.parts.push(...new Uint8Array(b));
    return this;
  }
  bytes(arr: number[]) { this.parts.push(...arr.map((x) => x & 0xff)); return this; }
  fill(n: number, v = 0) { for (let i = 0; i < n; i++) this.parts.push(v); return this; }
  ascii(s: string) { for (const ch of s) this.parts.push(ch.charCodeAt(0)); return this; }
  hex(): string { return this.parts.map((b) => b.toString(16).padStart(2, '0')).join(''); }
}

const header = (route: number, payload: number, version = 0) =>
  ((version & 0x03) << 6) | ((payload & 0x0f) << 2) | (route & 0x03);

describe('decodeMeshCorePacket', () => {
  it('returns null for empty input', () => {
    expect(decodeMeshCorePacket('')).toBeNull();
    expect(decodeMeshCorePacket(null)).toBeNull();
  });

  it('decodes the header (route/payload/version) bit fields', () => {
    // FLOOD (0x01) + TXT_MSG (0x02) + version 1, direct path.
    const hex = new Builder().u8(header(0x01, 0x02, 1)).u8(0xff).hex();
    const d = decodeMeshCorePacket(hex)!;
    expect(d.header.routeType).toBe(0x01);
    expect(d.header.routeTypeName).toBe('FLOOD');
    expect(d.header.payloadType).toBe(0x02);
    expect(d.header.payloadTypeName).toBe('TXT_MSG');
    expect(d.header.payloadVersion).toBe(1);
    expect(d.path.direct).toBe(true);
    expect(d.path.hops).toEqual([]);
  });

  it('parses transport codes for TRANSPORT_FLOOD packets', () => {
    const hex = new Builder()
      .u8(header(0x00, 0x04)) // TRANSPORT_FLOOD + ADVERT
      .u16le(0x1234)
      .u16le(0xabcd)
      .u8(0x00) // pathLen: hashSize 1, hopCount 0
      .fill(100, 0x11) // advert pubkey+ts+sig (no appData)
      .hex();
    const d = decodeMeshCorePacket(hex)!;
    expect(d.transportCodes).toEqual({ code1: 0x1234, code2: 0xabcd });
    expect(d.path.hopCount).toBe(0);
  });

  it('parses path hash width + hop count + per-hop hashes', () => {
    // pathLen 0x42 → hashSize=(0x42>>6)+1=2, hopCount=0x42&0x3f=2
    const hex = new Builder()
      .u8(header(0x02, 0x03)) // DIRECT + ACK
      .u8(0x42)
      .bytes([0xaa, 0xbb, 0xcc, 0xdd]) // two 2-byte hashes
      .bytes([0x01, 0x02]) // ack payload
      .hex();
    const d = decodeMeshCorePacket(hex)!;
    expect(d.path.hashSize).toBe(2);
    expect(d.path.hopCount).toBe(2);
    expect(d.path.hops).toEqual(['aabb', 'ccdd']);
    expect(d.payload.ack?.ackCodeHex).toBe('0102');
  });

  it('fully decodes an ADVERT payload (pubkey, timestamp, signature, name, lat/lon)', () => {
    const pubkey = Array.from({ length: 32 }, (_, i) => i + 1);
    const sig = Array.from({ length: 64 }, (_, i) => 0x80 + (i & 0x3f));
    const ts = 1_700_000_000;
    const flags = 0x10 | 0x80 | 0x02; // LATLON + NAME + advType REPEATER(2)
    const hex = new Builder()
      .u8(header(0x01, 0x04)) // FLOOD + ADVERT
      .u8(0xff) // direct
      .bytes(pubkey)
      .u32le(ts)
      .bytes(sig)
      .u8(flags)
      .i32le(37_500000) // lat 37.5
      .i32le(-122_250000) // lon -122.25
      .ascii('Repeater-1')
      .u8(0x00) // null terminator
      .hex();
    const d = decodeMeshCorePacket(hex)!;
    const a = d.payload.advert!;
    expect(a).toBeDefined();
    expect(a.publicKey).toBe('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
    expect(a.timestamp).toBe(ts);
    expect(a.signature).toHaveLength(128);
    expect(a.advType).toBe(2);
    expect(a.advTypeName).toBe('REPEATER');
    expect(a.latitude).toBeCloseTo(37.5, 5);
    expect(a.longitude).toBeCloseTo(-122.25, 5);
    expect(a.name).toBe('Repeater-1');
    expect(d.errors).toEqual([]);
  });

  it('surfaces plaintext dest/src hashes of an encrypted TXT_MSG', () => {
    const hex = new Builder()
      .u8(header(0x02, 0x02)) // DIRECT + TXT_MSG
      .u8(0x01) // 1 hop, 1-byte hash
      .bytes([0xab]) // relay hash
      .bytes([0x12, 0x34]) // dest, src
      .bytes([0xde, 0xad, 0xbe, 0xef]) // ciphertext
      .hex();
    const d = decodeMeshCorePacket(hex)!;
    expect(d.path.hops).toEqual(['ab']);
    expect(d.payload.message).toEqual({ destHash: '12', srcHash: '34', encryptedHex: 'deadbeef' });
  });

  it('does not throw on a truncated packet and records an error', () => {
    // Claims 3 hops of 1-byte hashes but provides none.
    const hex = new Builder().u8(header(0x01, 0x02)).u8(0x03).hex();
    const d = decodeMeshCorePacket(hex)!;
    expect(d).not.toBeNull();
    expect(d.errors.length).toBeGreaterThan(0);
  });

  it('hexToBytes tolerates whitespace/odd formatting', () => {
    expect(Array.from(hexToBytes('de ad be ef'))).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });
});

describe('decodeMeshCorePacket — MULTIPART (0x0a)', () => {
  it('decodes the remaining count and the wrapped ACK', () => {
    // payload[0] = remaining(2) << 4 | inner type ACK (0x03), then a 4-byte CRC.
    const hex = new Builder()
      .u8(header(0x02, 0x0a)) // DIRECT + MULTIPART
      .u8(0xff)               // direct path, no relay hashes
      .u8((2 << 4) | 0x03)
      .bytes([0xde, 0xad, 0xbe, 0xef])
      .hex();
    const d = decodeMeshCorePacket(hex)!;
    expect(d.header.payloadTypeName).toBe('MULTIPART');
    expect(d.payload.multipart).toEqual({
      remaining: 2,
      innerType: 0x03,
      innerTypeName: 'ACK',
      innerHex: 'deadbeef',
      ack: { ackCodeHex: 'deadbeef' },
    });
    expect(d.errors).toEqual([]);
  });

  it('names an unhandled wrapped type and leaves its bytes as hex', () => {
    // The firmware writes only inner ACKs today, so anything else is surfaced
    // rather than guessed at.
    const hex = new Builder()
      .u8(header(0x02, 0x0a))
      .u8(0xff)
      .u8((0 << 4) | 0x02) // last part, wrapping TXT_MSG
      .bytes([0x01, 0x02, 0x03])
      .hex();
    const d = decodeMeshCorePacket(hex)!;
    expect(d.payload.multipart?.remaining).toBe(0);
    expect(d.payload.multipart?.innerTypeName).toBe('TXT_MSG');
    expect(d.payload.multipart?.innerHex).toBe('010203');
    expect(d.payload.multipart?.ack).toBeUndefined();
  });

  it('records an error for a wrapped ACK whose CRC is truncated', () => {
    const hex = new Builder()
      .u8(header(0x02, 0x0a))
      .u8(0xff)
      .u8((1 << 4) | 0x03)
      .bytes([0xde, 0xad])
      .hex();
    const d = decodeMeshCorePacket(hex)!;
    expect(d.payload.multipart?.ack).toBeUndefined();
    expect(d.errors.join(';')).toContain('MULTIPART ACK');
  });
});

describe('decodeMeshCorePacket — CONTROL (0x0b)', () => {
  it('decodes a node-discovery request', () => {
    const hex = new Builder()
      .u8(header(0x02, 0x0b)) // DIRECT + CONTROL
      .u8(0xff)
      .u8(0x80)               // NODE_DISCOVER_REQ, prefix_only clear
      .u8(0x06)               // filter: repeater (1<<2) | room server (1<<1)
      .u32le(0x11223344)      // tag
      .hex();
    const d = decodeMeshCorePacket(hex)!;
    expect(d.header.payloadTypeName).toBe('CONTROL');
    expect(d.payload.control?.subTypeName).toBe('NODE_DISCOVER_REQ');
    expect(d.payload.control?.discoverRequest).toEqual({
      prefixOnly: false,
      filter: 0x06,
      tag: 0x11223344,
    });
    expect(d.payload.control?.discoverResponse).toBeUndefined();
  });

  it('reads prefix_only from the low bit of the request flags', () => {
    const hex = new Builder()
      .u8(header(0x02, 0x0b))
      .u8(0xff)
      .u8(0x81) // NODE_DISCOVER_REQ | prefix_only
      .u8(0x02)
      .u32le(7)
      .hex();
    const d = decodeMeshCorePacket(hex)!;
    expect(d.payload.control?.discoverRequest?.prefixOnly).toBe(true);
  });

  it('decodes a node-discovery response, including a negative SNR', () => {
    const hex = new Builder()
      .u8(header(0x02, 0x0b))
      .u8(0xff)
      .u8(0x90 | 0x02)   // NODE_DISCOVER_RESP | REPEATER
      .u8(0xf2)          // -14 as int8 → -3.5 dB
      .u32le(0x11223344)
      .fill(32, 0xab)    // full public key
      .hex();
    const d = decodeMeshCorePacket(hex)!;
    expect(d.payload.control?.discoverResponse).toEqual({
      advType: 2,
      advTypeName: 'REPEATER',
      snr: -3.5,
      tag: 0x11223344,
      publicKey: 'ab'.repeat(32),
    });
  });

  it('keeps an unknown sub-type as hex rather than guessing', () => {
    const hex = new Builder()
      .u8(header(0x02, 0x0b))
      .u8(0xff)
      .u8(0x30)
      .bytes([0xaa, 0xbb])
      .hex();
    const d = decodeMeshCorePacket(hex)!;
    expect(d.payload.control?.subTypeName).toBe('0x30');
    expect(d.payload.control?.dataHex).toBe('aabb');
    expect(d.payload.control?.discoverRequest).toBeUndefined();
    expect(d.errors).toEqual([]);
  });

  it('records an error for a truncated discovery response', () => {
    const hex = new Builder()
      .u8(header(0x02, 0x0b))
      .u8(0xff)
      .u8(0x90)
      .bytes([0x01, 0x02])
      .hex();
    const d = decodeMeshCorePacket(hex)!;
    expect(d.payload.control?.discoverResponse).toBeUndefined();
    expect(d.errors.join(';')).toContain('NODE_DISCOVER_RESP');
  });
});
