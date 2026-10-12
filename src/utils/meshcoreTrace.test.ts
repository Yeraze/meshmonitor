/**
 * Shared MeshCore TRACE decoding (#5742): the raw over-the-air packet a
 * Repeater logs, and its parity with the Companion TraceData push.
 */
import { describe, it, expect } from 'vitest';
import {
  decodeTracePacket,
  parseTraceDataPush,
  traceDataEventFromPacket,
  traceDataEventFromPush,
  type TraceDataBufferReader,
} from './meshcoreTrace.js';

const hex = (bytes: number[]): string => bytes.map((b) => (b & 0xff).toString(16).padStart(2, '0')).join('');
const u32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

/** A TRACE packet as `Packet::writeTo` lays it out. */
function traceFrame(o: {
  snrs: number[];
  hashes: number[];
  pathSz?: number;
  tag?: number;
  auth?: number;
  header?: number;
  transport?: number[];
}): string {
  return hex([
    o.header ?? 0x26, // TRACE (9 << 2) | DIRECT (2)
    ...(o.transport ?? []),
    o.snrs.length,
    ...o.snrs,
    ...u32(o.tag ?? 0xdeadbeef),
    ...u32(o.auth ?? 0),
    o.pathSz ?? 0,
    ...o.hashes,
  ]);
}

/** Minimal stand-in for meshcore.js's BufferReader. */
function reader(bytes: number[]): TraceDataBufferReader {
  const buf = Uint8Array.from(bytes);
  const view = new DataView(buf.buffer);
  let at = 0;
  return {
    readByte: () => buf[at++],
    readUInt8: () => buf[at++],
    readUInt32LE: () => { const v = view.getUint32(at, true); at += 4; return v; },
    readBytes: (n) => { const out = buf.slice(at, at + n); at += n; return out; },
    readInt8: () => view.getInt8(at++),
  };
}

describe('decodeTracePacket (#5742)', () => {
  it('decodes a finished direct TRACE with 1-byte hashes', () => {
    const p = decodeTracePacket(traceFrame({ snrs: [34, 0xea], hashes: [0xb1, 0xc3] }));
    expect(p).toEqual({
      tag: 0xdeadbeef, authCode: 0, flags: 0, hashBytes: 1,
      pathHashes: Uint8Array.from([0xb1, 0xc3]),
      pathSnrsQ: [34, -22], // 0xEA is int8 -22: quarter-dB, signed
      hopCount: 2, complete: true,
    });
  });

  it('decodes 2-byte hashes: the hop count is half the hash bytes', () => {
    const p = decodeTracePacket(traceFrame({ snrs: [40, 24], hashes: [0xb1, 0xc2, 0xc3, 0xd4], pathSz: 1, auth: 0x01020304 }));
    expect(p).toMatchObject({ hashBytes: 2, hopCount: 2, complete: true, pathSnrsQ: [40, 24], authCode: 0x01020304, flags: 1 });
    expect(Array.from(p!.pathHashes)).toEqual([0xb1, 0xc2, 0xc3, 0xd4]);
  });

  it('decodes a packet caught mid-route: fewer SNRs than hops', () => {
    const first = decodeTracePacket(traceFrame({ snrs: [], hashes: [0xb1, 0xc3, 0xb1] }));
    expect(first).toMatchObject({ pathSnrsQ: [], hopCount: 3, complete: false });
    const mid = decodeTracePacket(traceFrame({ snrs: [34], hashes: [0xb1, 0xc3, 0xb1] }));
    expect(mid).toMatchObject({ pathSnrsQ: [34], hopCount: 3, complete: false });
  });

  it('skips the 4 transport-code bytes of a TRANSPORT_DIRECT packet', () => {
    const p = decodeTracePacket(traceFrame({ header: 0x27, transport: [1, 2, 3, 4], snrs: [8], hashes: [0xb1] }));
    expect(p).toMatchObject({ tag: 0xdeadbeef, pathSnrsQ: [8], hopCount: 1, complete: true });
  });

  it('ignores every packet that is not a direct TRACE', () => {
    // GRP_TXT flood, advert flood, direct TXT_MSG.
    expect(decodeTracePacket('1500aabbccddeeff00112233')).toBeNull();
    expect(decodeTracePacket('1100' + 'ab'.repeat(40))).toBeNull();
    expect(decodeTracePacket('0a01b1' + 'cd'.repeat(20))).toBeNull();
    // TRACE payload type on a flood route: the firmware never sends or handles it.
    expect(decodeTracePacket(traceFrame({ header: 0x25, snrs: [8], hashes: [0xb1] }))).toBeNull();
    expect(decodeTracePacket(traceFrame({ header: 0x24, transport: [1, 2, 3, 4], snrs: [8], hashes: [0xb1] }))).toBeNull();
  });

  it('ignores malformed input without throwing', () => {
    expect(decodeTracePacket('')).toBeNull();
    expect(decodeTracePacket('26')).toBeNull();
    expect(decodeTracePacket('2600zz')).toBeNull();
    expect(decodeTracePacket('260')).toBeNull();
    expect(decodeTracePacket(undefined as unknown as string)).toBeNull();
    // Cut off inside the tag / before the hashes.
    expect(decodeTracePacket('2600deadbe')).toBeNull();
    expect(decodeTracePacket(traceFrame({ snrs: [], hashes: [] }))).toBeNull();
    // SNR count runs past the frame.
    expect(decodeTracePacket('2630' + '00'.repeat(12))).toBeNull();
    // A set top bit in the count is not a TRACE path length.
    expect(decodeTracePacket(hex([0x26, 0x41, 8, ...u32(1), ...u32(0), 0, 0xb1]))).toBeNull();
    // 2-byte hashes with an odd number of hash bytes.
    expect(decodeTracePacket(traceFrame({ snrs: [8], hashes: [0xb1, 0xc2, 0xc3], pathSz: 1 }))).toBeNull();
    // More SNRs than hops.
    expect(decodeTracePacket(traceFrame({ snrs: [8, 9, 10], hashes: [0xb1, 0xc3] }))).toBeNull();
    // Transport header with no room for the codes.
    expect(decodeTracePacket('270102')).toBeNull();
  });
});

describe('traceDataEventFromPacket (#5742)', () => {
  it('turns the whole-dB RX reading into quarter-dB, and has none without an RX line', () => {
    const packet = decodeTracePacket(traceFrame({ snrs: [34], hashes: [0xb1, 0xc3] }))!;
    expect(traceDataEventFromPacket(packet, -7)).toEqual({
      tag: 0xdeadbeef, auth_code: 0, flags: 0, hash_bytes: 1,
      path_hashes_hex: 'b1c3', path_snrs_q: [34], last_snr_q: -28, initiated: false,
    });
    expect(traceDataEventFromPacket(packet, undefined).last_snr_q).toBeNull();
    // Outside what one signed byte of quarter-dB can hold: not a real reading.
    expect(traceDataEventFromPacket(packet, 40).last_snr_q).toBeNull();
  });

  it.each([
    { name: '1-byte hashes', pathSz: 0, hashes: [0xb1, 0xc3] },
    { name: '2-byte hashes', pathSz: 1, hashes: [0xb1, 0xc2, 0xc3, 0xd4] },
  ])('a finished trace gives the same event as the Companion push ($name)', ({ pathSz, hashes }) => {
    const snrs = [34, 0xea];
    // Push body (firmware onTraceRecv): reserved, path_len, flags, tag, auth,
    // hashes, SNRs, then the SNR at the local radio (3 dB = 12 quarter-dB).
    const push = parseTraceDataPush(reader([0, hashes.length, pathSz, ...u32(0xdeadbeef), ...u32(5), ...hashes, ...snrs, 12]));
    const fromPush = traceDataEventFromPush(push, false);
    const fromPacket = traceDataEventFromPacket(decodeTracePacket(traceFrame({ snrs, hashes, pathSz, auth: 5 }))!, 3);
    expect(fromPacket).toEqual(fromPush);
    expect(fromPush).toEqual({
      tag: 0xdeadbeef, auth_code: 5, flags: pathSz, hash_bytes: 1 << pathSz,
      path_hashes_hex: hex(hashes), path_snrs_q: [34, -22], last_snr_q: 12, initiated: false,
    });
  });
});
