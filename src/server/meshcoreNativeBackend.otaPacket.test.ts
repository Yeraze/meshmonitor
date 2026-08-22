/**
 * Tests for the MeshCore Packet Monitor capture path in MeshCoreNativeBackend.
 *
 * The `LogRxData` (0x88) push handler must:
 *   1. emit an `ota_packet` bridge event for EVERY parsed packet (not just
 *      TXT_MSG), carrying route/payload type, decoded path, SNR/RSSI and raw
 *      bytes;
 *   2. still buffer the relay-hash chain for text-message packets so the
 *      following recv event can attach it — TXT_MSG (0x02) → ContactMsgRecv
 *      (DM) and GRP_TXT (0x05) → ChannelMsgRecv (channel/group), issue #3710.
 *
 * Uses an isolated mock meshcore.js module that — unlike the shared harness in
 * meshcoreNativeBackend.test.ts — provides a `Packet` constructor and the
 * LogRxData push code.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { MeshCoreNativeBackend, __setMeshCoreModule } from './meshcoreNativeBackend.js';

const ResponseCodes = {
  Ok: 0, Err: 1, ContactsStart: 2, Contact: 3, EndOfContacts: 4,
  SelfInfo: 5, Sent: 6, ContactMsgRecv: 7, ChannelMsgRecv: 8,
  CurrTime: 9, NoMoreMessages: 10, Stats: 24,
};
const PushCodes = {
  Advert: 0x80, PathUpdated: 0x81, MsgWaiting: 0x83, NewAdvert: 0x8a,
  LogRxData: 0x88,
};
const StatsTypes = { Core: 0, Radio: 1, Packets: 2 };
const SelfAdvertTypes = { ZeroHop: 0, Flood: 1 };
const BinaryRequestTypes = { GetTelemetryData: 0x03 };
const AdvType = { None: 0, Chat: 1, Repeater: 2, Room: 3 };
const TxtTypes = { Plain: 0, CliData: 1, SignedPlain: 2 };

// Mock Packet parser — real MeshCore OTA wire layout (matches meshcore.js /
// decodeMeshCorePacket) so LogRxData buffering and extractTxtMsgSenderPrefix
// see the same bytes production does:
//   raw[0] = header byte (route in low 2 bits, payload type in bits 2–5)
//   raw[1] = pathLen (packed: top 2 bits = hashSize-1, bottom 6 = hopCount)
//   raw[2..] = path bytes (+ payload for TXT_MSG tests)
const PAYLOAD_NAMES: Record<number, string> = { 0x02: 'TXT_MSG', 0x04: 'ADVERT', 0x05: 'GRP_TXT' };
const ROUTE_NAMES: Record<number, string> = { 0x01: 'FLOOD', 0x02: 'DIRECT' };

const wireHeader = (route: number, payload: number) => ((payload & 0x0f) << 2) | (route & 0x03);
const floodTxt = (pathLen: number, ...rest: number[]) =>
  Uint8Array.from([wireHeader(0x01, 0x02), pathLen, ...rest]);
const floodGrp = (pathLen: number, ...rest: number[]) =>
  Uint8Array.from([wireHeader(0x01, 0x05), pathLen, ...rest]);
const directTxt = (pathLen: number, ...rest: number[]) =>
  Uint8Array.from([wireHeader(0x02, 0x02), pathLen, ...rest]);
const directGrp = (pathLen: number, ...rest: number[]) =>
  Uint8Array.from([wireHeader(0x02, 0x05), pathLen, ...rest]);
const directAdvert = (pathLen: number, ...rest: number[]) =>
  Uint8Array.from([wireHeader(0x02, 0x04), pathLen, ...rest]);

class MockPacket {
  static PAYLOAD_TYPE_TXT_MSG = 0x02;
  static PAYLOAD_TYPE_GRP_TXT = 0x05;
  static fromBytes(raw: Uint8Array | number[]) {
    const arr = raw instanceof Uint8Array ? raw : Uint8Array.from(raw);
    const header = arr[0];
    const route_type = header & 0x03;
    const payload_type = (header >> 2) & 0x0f;
    let offset = 1;
    if (route_type === 0x00 || route_type === 0x03) offset += 4;
    const pathLen = arr[offset++];
    const path = arr.subarray(offset);
    return {
      payload_type,
      payload_type_string: PAYLOAD_NAMES[payload_type] ?? 'OTHER',
      route_type,
      route_type_string: ROUTE_NAMES[route_type] ?? 'OTHER',
      pathLen,
      path,
    };
  }
  static extractPathHashSize(pathLen: number): number {
    return ((pathLen >> 6) & 0x3) + 1;
  }
  static extractPathHashCount(pathLen: number): number {
    return pathLen & 0x3f;
  }
}

class MockConnection extends EventEmitter {
  async connect() { /* no-op */ }
  async close() { /* no-op */ }
  async getSelfInfo() {
    return {
      type: AdvType.Chat,
      publicKey: Uint8Array.from(Array(32).fill(0)),
      name: 'TestNode',
    };
  }
}

function installMockModule(): void {
  __setMeshCoreModule({
    NodeJSSerialConnection: MockConnection as any,
    TCPConnection: MockConnection as any,
    Constants: {
      ResponseCodes, PushCodes, StatsTypes, SelfAdvertTypes,
      BinaryRequestTypes, AdvType, TxtTypes,
    } as any,
    CayenneLpp: { parse: () => [] } as any,
    Packet: MockPacket as any,
  });
}

async function connectedBackend(): Promise<{ backend: MeshCoreNativeBackend; conn: MockConnection; events: any[] }> {
  const backend = new MeshCoreNativeBackend('src-otapkt', {
    connectionType: 'serial',
    serialPort: '/dev/ttyUSB0',
  });
  const events: any[] = [];
  backend.on('event', (e) => events.push(e));
  await backend.connect();
  // The backend constructs the connection internally; grab it back off the
  // private field for emitting pushes.
  const conn = (backend as any).connection as MockConnection;
  return { backend, conn, events };
}

describe('MeshCoreNativeBackend — ota_packet capture', () => {
  beforeEach(() => installMockModule());
  afterEach(() => __setMeshCoreModule(null));

  it('emits ota_packet for a TXT_MSG flood packet with decoded path + SNR/RSSI', async () => {
    const { conn, events } = await connectedBackend();
    // TXT_MSG, FLOOD, pathLen=0x02 (1-byte hashes, 2 hops), path=[a3,7f]
    const raw = floodTxt(0x02, 0xa3, 0x7f);
    conn.emit(PushCodes.LogRxData, { lastSnr: 6.25, lastRssi: -42, raw });

    const ota = events.find((e) => e.event_type === 'ota_packet');
    expect(ota).toBeDefined();
    expect(ota.data.payload_type).toBe(0x02);
    expect(ota.data.payload_type_string).toBe('TXT_MSG');
    expect(ota.data.route_type).toBe(0x01);
    expect(ota.data.route_type_string).toBe('FLOOD');
    expect(ota.data.hop_count).toBe(2);
    expect(ota.data.path_hops).toEqual(['a3', '7f']);
    expect(ota.data.snr).toBe(6.25);
    expect(ota.data.rssi).toBe(-42);
    expect(ota.data.payload_size).toBe(4);
    expect(ota.data.raw_hex).toBe('0902a37f');
    expect(ota.data.path_len_raw).toBe(0x02);
  });

  it('emits ota_packet for non-TXT_MSG payloads (e.g. ADVERT, direct route)', async () => {
    const { conn, events } = await connectedBackend();
    // ADVERT, DIRECT, pathLen=0xff (no relay hashes)
    const raw = directAdvert(0xff);
    conn.emit(PushCodes.LogRxData, { lastSnr: -1, lastRssi: -90, raw });

    const ota = events.find((e) => e.event_type === 'ota_packet');
    expect(ota).toBeDefined();
    expect(ota.data.payload_type_string).toBe('ADVERT');
    expect(ota.data.route_type_string).toBe('DIRECT');
    expect(ota.data.hop_count).toBe(0);
    expect(ota.data.path_hops).toEqual([]);
    expect(ota.data.path_len_raw).toBe(0xff);
  });

  it('still buffers the TXT_MSG path for the following ContactMsgRecv event', async () => {
    const { conn, events } = await connectedBackend();
    const raw = floodTxt(0x02, 0xa3, 0x7f);
    conn.emit(PushCodes.LogRxData, { lastSnr: 5, lastRssi: -40, raw });
    // Following txt-msg recv on the same packet consumes the buffered path.
    conn.emit(ResponseCodes.ContactMsgRecv, {
      pubKeyPrefix: Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01]),
      text: 'hello',
      senderTimestamp: 1700,
      pathLen: 0x02,
      txtType: TxtTypes.Plain,
    });

    const msg = events.find((e) => e.event_type === 'contact_message');
    expect(msg).toBeDefined();
    expect(msg.data.path_hops).toEqual(['a3', '7f']);
    // SNR from the LogRxData metadata is carried onto the message event so
    // {SNR} resolves in auto-ack/auto-responder templates (#3450-followup).
    expect(msg.data.snr).toBe(5);
  });

  it('carries the buffered LogRxData SNR onto a channel_message event', async () => {
    const { conn, events } = await connectedBackend();
    // Channel messages ride GRP_TXT (0x05) on the wire, not TXT_MSG (0x02).
    const raw = floodGrp(0x02, 0xa3, 0x7f);
    conn.emit(PushCodes.LogRxData, { lastSnr: -3.5, lastRssi: -88, raw });
    conn.emit(ResponseCodes.ChannelMsgRecv, {
      channelIdx: 0,
      text: 'Alice: ping',
      senderTimestamp: 1800,
      pathLen: 0x02,
    });

    const msg = events.find((e) => e.event_type === 'channel_message');
    expect(msg).toBeDefined();
    expect(msg.data.snr).toBe(-3.5);
    expect(msg.data.path_hops).toEqual(['a3', '7f']);
  });

  it('buffers a GRP_TXT (channel) path so {ROUTE}/{SNR} resolve on routed channel messages (issue #3710)', async () => {
    // Regression: the LogRxData handler originally buffered the path only for
    // TXT_MSG (0x02 / DMs). Channel + private messages ride GRP_TXT (0x05), so
    // their path was never buffered and ChannelMsgRecv got nothing — {ROUTE}
    // resolved to "—" on routed channel messages while DMs worked. The "hit or
    // miss" users saw was a coincidental stale TXT_MSG buffer being matched.
    const { conn, events } = await connectedBackend();
    // GRP_TXT (0x05), FLOOD, packed pathLen=0x42 (2-byte hashes, 2 hops).
    const raw = floodGrp(0x42, 0xde, 0xad, 0xbe, 0xef);
    conn.emit(PushCodes.LogRxData, { lastSnr: 3.25, lastRssi: -55, raw });
    conn.emit(ResponseCodes.ChannelMsgRecv, {
      channelIdx: 0,
      text: 'Carol: routed hello',
      senderTimestamp: 2000,
      pathLen: 2, // plain hop count from ChannelMsgRecv
    });

    const msg = events.find((e) => e.event_type === 'channel_message');
    expect(msg).toBeDefined();
    expect(msg.data.path_hops).toEqual(['dead', 'beef']);
    expect(msg.data.snr).toBe(3.25);
  });

  it('attaches an empty path for a direct (non-routed) GRP_TXT channel message (issue #3710)', async () => {
    // Completes the matrix: a direct channel message (pathLen 0xff → 0 hops)
    // buffers an empty hop list and still carries SNR. {ROUTE} renders this as
    // "(direct)" downstream, matching the DM direct-path behavior.
    const { conn, events } = await connectedBackend();
    // GRP_TXT (0x05), DIRECT, pathLen=0xff (sent direct, no relay hashes).
    const raw = directGrp(0xff);
    conn.emit(PushCodes.LogRxData, { lastSnr: 7.0, lastRssi: -38, raw });
    conn.emit(ResponseCodes.ChannelMsgRecv, {
      channelIdx: 0,
      text: 'Dave: direct hello',
      senderTimestamp: 2100,
      pathLen: 0xff, // sent direct
    });

    const msg = events.find((e) => e.event_type === 'channel_message');
    expect(msg).toBeDefined();
    expect(msg.data.path_hops).toEqual([]);
    expect(msg.data.snr).toBe(7.0);
  });

  it('leaves snr undefined on a message with no preceding LogRxData', async () => {
    const { conn, events } = await connectedBackend();
    conn.emit(ResponseCodes.ContactMsgRecv, {
      pubKeyPrefix: Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01]),
      text: 'hello',
      senderTimestamp: 1700,
      pathLen: 0x02,
      txtType: TxtTypes.Plain,
    });
    const msg = events.find((e) => e.event_type === 'contact_message');
    expect(msg).toBeDefined();
    expect(msg.data.snr).toBeUndefined();
    expect(msg.data.path_hops).toBeUndefined();
  });

  it('does not throw on malformed LogRxData (empty raw)', async () => {
    const { conn, events } = await connectedBackend();
    expect(() => conn.emit(PushCodes.LogRxData, { lastSnr: 0, lastRssi: 0, raw: new Uint8Array(0) })).not.toThrow();
    expect(events.find((e) => e.event_type === 'ota_packet')).toBeUndefined();
  });

  // --- issue #3589: buffered-path mis-correlation guards ---------------------

  it('does NOT attach a buffered path when the recv pathLen differs (different packet)', async () => {
    const { conn, events } = await connectedBackend();
    // LogRxData buffers a 2-hop path with pathLen=0x02.
    const raw = floodTxt(0x02, 0xa3, 0x7f);
    conn.emit(PushCodes.LogRxData, { lastSnr: 9, lastRssi: -30, raw });
    // The recv that follows is a DIFFERENT packet (direct, pathLen=0xff) whose
    // own LogRxData never arrived. The buffered 0x02 path must NOT be attached.
    conn.emit(ResponseCodes.ContactMsgRecv, {
      pubKeyPrefix: Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01]),
      text: 'hello',
      senderTimestamp: 1700,
      pathLen: 0xff,
      txtType: TxtTypes.Plain,
    });
    const msg = events.find((e) => e.event_type === 'contact_message');
    expect(msg).toBeDefined();
    expect(msg.data.snr).toBeUndefined();
    expect(msg.data.path_hops).toBeUndefined();
  });

  it('keeps each of two concurrent text packets buffered (FIFO, no single-slot clobber)', async () => {
    // Real-world bug: on a busy mesh a second text packet's LogRxData arrived
    // before the first packet's recv consumed its buffer. With a single slot the
    // second LogRxData clobbered the first, so the first message lost its
    // route/SNR and — most visibly — its scope/region (raw_hex). The FIFO keeps
    // both, matched to their recvs by hop count.
    const { conn, events } = await connectedBackend();
    // Packet A: GRP_TXT FLOOD, 2-byte hashes, 2 hops (packed 0x42).
    const rawA = floodGrp(0x42, 0xde, 0xad, 0xbe, 0xef);
    // Packet B: GRP_TXT FLOOD, 1-byte hash, 1 hop (packed 0x01).
    const rawB = floodGrp(0x01, 0xaa);
    // Both LogRxData pushes land BEFORE either recv (the clobber window).
    conn.emit(PushCodes.LogRxData, { lastSnr: 3.25, lastRssi: -55, raw: rawA });
    conn.emit(PushCodes.LogRxData, { lastSnr: 7.0, lastRssi: -38, raw: rawB });
    // Recvs arrive in order; each must pick up its OWN buffered packet by hops.
    conn.emit(ResponseCodes.ChannelMsgRecv, { channelIdx: 0, text: 'Alice: first', senderTimestamp: 3000, pathLen: 2 });
    conn.emit(ResponseCodes.ChannelMsgRecv, { channelIdx: 0, text: 'Bob: second', senderTimestamp: 3100, pathLen: 1 });

    const msgs = events.filter((e) => e.event_type === 'channel_message');
    expect(msgs).toHaveLength(2);
    // First message keeps packet A's path + SNR + raw bytes (not clobbered).
    expect(msgs[0].data.path_hops).toEqual(['dead', 'beef']);
    expect(msgs[0].data.snr).toBe(3.25);
    expect(msgs[0].data.raw_hex).toBe('1542deadbeef');
    // Second message keeps packet B's.
    expect(msgs[1].data.path_hops).toEqual(['aa']);
    expect(msgs[1].data.snr).toBe(7.0);
    expect(msgs[1].data.raw_hex).toBe('1501aa');
  });

  it('does NOT attach a stale buffered path (older than the freshness window)', async () => {
    vi.useFakeTimers();
    try {
      const { conn, events } = await connectedBackend();
      const raw = floodTxt(0x02, 0xa3, 0x7f);
      conn.emit(PushCodes.LogRxData, { lastSnr: 7, lastRssi: -35, raw });
      // Advance well past PENDING_PATH_MAX_AGE_MS (2000ms) before the recv lands.
      vi.advanceTimersByTime(3000);
      conn.emit(ResponseCodes.ContactMsgRecv, {
        pubKeyPrefix: Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01]),
        text: 'late',
        senderTimestamp: 1700,
        pathLen: 0x02,
        txtType: TxtTypes.Plain,
      });
      const msg = events.find((e) => e.event_type === 'contact_message');
      expect(msg).toBeDefined();
      expect(msg.data.snr).toBeUndefined();
      expect(msg.data.path_hops).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still correlates when LogRxData→recv gap is ~600ms (live companion delay)', async () => {
    vi.useFakeTimers();
    try {
      const { conn, events } = await connectedBackend();
      const raw = floodGrp(0x02, 0xa3, 0x7f);
      conn.emit(PushCodes.LogRxData, { lastSnr: 5.5, lastRssi: -80, raw });
      vi.advanceTimersByTime(600);
      conn.emit(ResponseCodes.ChannelMsgRecv, {
        channelIdx: 0,
        text: 'Alice: ping',
        senderTimestamp: 1700,
        pathLen: 2,
      });
      const msg = events.find((e) => e.event_type === 'channel_message');
      expect(msg).toBeDefined();
      expect(msg.data.snr).toBe(5.5);
      expect(msg.data.path_hops).toEqual(['a3', '7f']);
      expect(msg.data.raw_hex).toBe('1502a37f');
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips a stale orphan and attaches the fresh hop match on busy channels', async () => {
    vi.useFakeTimers();
    try {
      const { conn, events } = await connectedBackend();
      const orphan = floodGrp(0x02, 0xaa, 0xbb);
      const fresh = floodGrp(0x02, 0xa3, 0x7f);
      conn.emit(PushCodes.LogRxData, { lastSnr: 1, lastRssi: -90, raw: orphan });
      vi.advanceTimersByTime(800);
      conn.emit(PushCodes.LogRxData, { lastSnr: 5.5, lastRssi: -80, raw: fresh });
      vi.advanceTimersByTime(100);
      conn.emit(ResponseCodes.ChannelMsgRecv, {
        channelIdx: 0,
        text: 'Bob: ping',
        senderTimestamp: 1800,
        pathLen: 2,
      });
      const msg = events.find((e) => e.event_type === 'channel_message');
      expect(msg?.data.snr).toBe(5.5);
      expect(msg?.data.path_hops).toEqual(['a3', '7f']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('disambiguates same-hop DMs by sender pubkey prefix', async () => {
    const dest = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66];
    const senderA = [0xde, 0xad, 0xbe, 0xef, 0x00, 0x01];
    const senderB = [0xca, 0xfe, 0xba, 0xbe, 0x00, 0x02];
    const rawA = floodTxt(0x02, 0xa3, 0x7f, ...dest, ...senderA, 0x01);
    const rawB = floodTxt(0x02, 0x11, 0x22, ...dest, ...senderB, 0x02);
    const { conn, events } = await connectedBackend();
    conn.emit(PushCodes.LogRxData, { lastSnr: 3, lastRssi: -50, raw: rawA });
    conn.emit(PushCodes.LogRxData, { lastSnr: 7, lastRssi: -40, raw: rawB });
    conn.emit(ResponseCodes.ContactMsgRecv, {
      pubKeyPrefix: Uint8Array.from(senderA),
      text: 'from A',
      senderTimestamp: 1700,
      pathLen: 0x02,
      txtType: TxtTypes.Plain,
    });
    conn.emit(ResponseCodes.ContactMsgRecv, {
      pubKeyPrefix: Uint8Array.from(senderB),
      text: 'from B',
      senderTimestamp: 1701,
      pathLen: 0x02,
      txtType: TxtTypes.Plain,
    });
    const msgs = events.filter((e) => e.event_type === 'contact_message');
    expect(msgs).toHaveLength(2);
    expect(msgs[0].data.snr).toBe(3);
    expect(msgs[1].data.snr).toBe(7);
  });

  it('consumes the buffer once — a second recv with no LogRxData gets nothing', async () => {
    const { conn, events } = await connectedBackend();
    const raw = floodTxt(0x02, 0xa3, 0x7f);
    conn.emit(PushCodes.LogRxData, { lastSnr: 4, lastRssi: -50, raw });
    // First recv consumes the buffer.
    conn.emit(ResponseCodes.ContactMsgRecv, {
      pubKeyPrefix: Uint8Array.from([0x11, 0x22, 0x33, 0x44, 0x55, 0x66]),
      text: 'first',
      senderTimestamp: 1700,
      pathLen: 0x02,
      txtType: TxtTypes.Plain,
    });
    // Second recv (no preceding LogRxData) must NOT reuse the consumed buffer.
    conn.emit(ResponseCodes.ContactMsgRecv, {
      pubKeyPrefix: Uint8Array.from([0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc]),
      text: 'second',
      senderTimestamp: 1800,
      pathLen: 0x02,
      txtType: TxtTypes.Plain,
    });
    const msgs = events.filter((e) => e.event_type === 'contact_message');
    expect(msgs).toHaveLength(2);
    expect(msgs[0].data.snr).toBe(4);
    expect(msgs[0].data.path_hops).toEqual(['a3', '7f']);
    expect(msgs[1].data.snr).toBeUndefined();
    expect(msgs[1].data.path_hops).toBeUndefined();
  });

  it('a room post consumes (and discards) the buffer so it cannot leak onto the next message', async () => {
    const { conn, events } = await connectedBackend();
    // LogRxData for the room post's own packet.
    const raw = floodTxt(0x02, 0xa3, 0x7f);
    conn.emit(PushCodes.LogRxData, { lastSnr: 8, lastRssi: -25, raw });
    // Room post (SignedPlain) — first 4 bytes of text are the author prefix.
    conn.emit(ResponseCodes.ContactMsgRecv, {
      pubKeyPrefix: Uint8Array.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]),
      text: '\x01\x02\x03\x04hello room',
      senderTimestamp: 1700,
      pathLen: 0x02,
      txtType: TxtTypes.SignedPlain,
    });
    // A subsequent DM (no LogRxData of its own) must NOT inherit the room
    // post's buffered SNR/path.
    conn.emit(ResponseCodes.ContactMsgRecv, {
      pubKeyPrefix: Uint8Array.from([0x11, 0x22, 0x33, 0x44, 0x55, 0x66]),
      text: 'plain dm',
      senderTimestamp: 1800,
      pathLen: 0x02,
      txtType: TxtTypes.Plain,
    });
    const room = events.find((e) => e.event_type === 'room_message');
    expect(room).toBeDefined();
    const dm = events.find((e) => e.event_type === 'contact_message');
    expect(dm).toBeDefined();
    expect(dm.data.snr).toBeUndefined();
    expect(dm.data.path_hops).toBeUndefined();
  });

  // --- issue #3710: hop-count (not raw-byte) correlation -----------------------
  // The recv event's pathLen is a PLAIN hop count (0xFF == direct), while the
  // buffered LogRxData rawPathLen is the PACKED OTA byte (top 2 bits = hash
  // width). For any flood packet using a 2- or 3-byte relay-hash width the two
  // raw values differ even for the SAME packet, so the old raw-equality guard
  // dropped the path and {ROUTE} resolved to "—". We must correlate on the
  // decoded hop count instead.

  it('attaches the buffered path for a 2-byte-hash flood packet (issue #3710)', async () => {
    const { conn, events } = await connectedBackend();
    // TXT_MSG, FLOOD, packed pathLen=0x42 (2-byte hashes, 2 hops),
    // path = [adb0, 1234]. extractPathHashCount(0x42) === 2.
    const raw = floodTxt(0x42, 0xad, 0xb0, 0x12, 0x34);
    conn.emit(PushCodes.LogRxData, { lastSnr: 5.5, lastRssi: -44, raw });
    // The matching recv reports a PLAIN hop count of 2, NOT the packed 0x42.
    conn.emit(ResponseCodes.ContactMsgRecv, {
      pubKeyPrefix: Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01]),
      text: 'routed hello',
      senderTimestamp: 1700,
      pathLen: 2,
      txtType: TxtTypes.Plain,
    });
    const msg = events.find((e) => e.event_type === 'contact_message');
    expect(msg).toBeDefined();
    expect(msg.data.path_hops).toEqual(['adb0', '1234']);
    expect(msg.data.snr).toBe(5.5);
  });

  it('attaches the buffered path for a 2-byte-hash flood channel_message (issue #3710)', async () => {
    const { conn, events } = await connectedBackend();
    // GRP_TXT (0x05), FLOOD, packed pathLen=0x42 (2-byte hashes, 2 hops).
    const raw = floodGrp(0x42, 0xad, 0xb0, 0x12, 0x34);
    conn.emit(PushCodes.LogRxData, { lastSnr: -2.0, lastRssi: -70, raw });
    conn.emit(ResponseCodes.ChannelMsgRecv, {
      channelIdx: 0,
      text: 'Bob: routed ping',
      senderTimestamp: 1800,
      pathLen: 2,
    });
    const msg = events.find((e) => e.event_type === 'channel_message');
    expect(msg).toBeDefined();
    expect(msg.data.path_hops).toEqual(['adb0', '1234']);
    expect(msg.data.snr).toBe(-2.0);
  });

  it('still rejects a buffered 2-byte-hash path when hop counts differ (issue #3710 guard intact)', async () => {
    const { conn, events } = await connectedBackend();
    // Buffered: 2-byte hashes, 2 hops (packed 0x42).
    const raw = floodTxt(0x42, 0xad, 0xb0, 0x12, 0x34);
    conn.emit(PushCodes.LogRxData, { lastSnr: 9, lastRssi: -30, raw });
    // Recv is a different packet: 3 hops. 3 !== decoded(0x42)=2 → reject.
    conn.emit(ResponseCodes.ContactMsgRecv, {
      pubKeyPrefix: Uint8Array.from([0x11, 0x22, 0x33, 0x44, 0x55, 0x66]),
      text: 'different',
      senderTimestamp: 1900,
      pathLen: 3,
      txtType: TxtTypes.Plain,
    });
    const msg = events.find((e) => e.event_type === 'contact_message');
    expect(msg).toBeDefined();
    expect(msg.data.path_hops).toBeUndefined();
    expect(msg.data.snr).toBeUndefined();
  });
});

/**
 * RSSI correlation onto received messages (#4504).
 *
 * The companion's ContactMsgRecv / ChannelMsgRecv frames carry only
 * `pubKeyPrefix|channelIdx, pathLen, txtType, senderTimestamp, text` — no
 * signal metadata at all. SNR and RSSI arrive on the preceding LogRxData push,
 * which this backend already buffers and correlates by freshness + hop count
 * (the #3589 guard). RSSI was parsed there all along and simply never added to
 * the buffer, so it never reached the message.
 */
describe('MeshCoreNativeBackend — RSSI on received messages (#4504)', () => {
  beforeEach(() => installMockModule());
  afterEach(() => __setMeshCoreModule(null));

  // TXT_MSG, DIRECT, pathLen 0xff → 0 hops.
  const directTxtPkt = () => directTxt(0xff);
  // GRP_TXT, DIRECT, pathLen 0xff → 0 hops.
  const directGrpPkt = () => directGrp(0xff);

  it('attaches RSSI (with SNR) to a DM from the preceding LogRxData', async () => {
    const { conn, events } = await connectedBackend();
    conn.emit(PushCodes.LogRxData, { lastSnr: 6.5, lastRssi: -47, raw: directTxtPkt() });
    conn.emit(ResponseCodes.ContactMsgRecv, {
      pubKeyPrefix: Uint8Array.from([1, 2, 3, 4, 5, 6]),
      pathLen: 0xff, txtType: 0, senderTimestamp: 1700000001, text: 'hi',
    });

    const msg = events.find((e) => e.event_type === 'contact_message');
    expect(msg.data.snr).toBe(6.5);
    expect(msg.data.rssi).toBe(-47);
  });

  it('attaches RSSI to a channel message too', async () => {
    const { conn, events } = await connectedBackend();
    conn.emit(PushCodes.LogRxData, { lastSnr: 4, lastRssi: -61, raw: directGrpPkt() });
    conn.emit(ResponseCodes.ChannelMsgRecv, {
      channelIdx: 0, pathLen: 0xff, txtType: 0, senderTimestamp: 1700000002, text: 'yo',
    });

    const msg = events.find((e) => e.event_type === 'channel_message');
    expect(msg.data.snr).toBe(4);
    expect(msg.data.rssi).toBe(-61);
  });

  it('leaves RSSI undefined when no LogRxData preceded the message', async () => {
    // Backend started without raw logging, or the push was missed. Better to
    // show nothing than to attach a neighbouring packet's signal.
    const { conn, events } = await connectedBackend();
    conn.emit(ResponseCodes.ContactMsgRecv, {
      pubKeyPrefix: Uint8Array.from([1, 2, 3, 4, 5, 6]),
      pathLen: 0xff, txtType: 0, senderTimestamp: 1700000003, text: 'orphan',
    });

    const msg = events.find((e) => e.event_type === 'contact_message');
    expect(msg.data.rssi).toBeUndefined();
    expect(msg.data.snr).toBeUndefined();
  });

  it('does not attach a mismatched packet\'s RSSI (the #3589 guard still holds)', async () => {
    // Buffered packet is 2 hops; the message says direct. Different packets —
    // attaching would report another node's signal strength as this sender's.
    const { conn, events } = await connectedBackend();
    conn.emit(PushCodes.LogRxData, {
      lastSnr: 9, lastRssi: -20,
      raw: floodTxt(0x02, 0xa3, 0x7f), // TXT_MSG, FLOOD, 2 hops
    });
    conn.emit(ResponseCodes.ContactMsgRecv, {
      pubKeyPrefix: Uint8Array.from([1, 2, 3, 4, 5, 6]),
      pathLen: 0xff, txtType: 0, senderTimestamp: 1700000004, text: 'direct',
    });

    const msg = events.find((e) => e.event_type === 'contact_message');
    expect(msg.data.rssi).toBeUndefined();
  });

  it('consumes the buffer once — a second message gets no stale RSSI', async () => {
    const { conn, events } = await connectedBackend();
    conn.emit(PushCodes.LogRxData, { lastSnr: 3, lastRssi: -70, raw: directTxtPkt() });
    const recv = (ts: number, text: string) => conn.emit(ResponseCodes.ContactMsgRecv, {
      pubKeyPrefix: Uint8Array.from([1, 2, 3, 4, 5, 6]),
      pathLen: 0xff, txtType: 0, senderTimestamp: ts, text,
    });
    recv(1700000005, 'first');
    recv(1700000006, 'second');

    const msgs = events.filter((e) => e.event_type === 'contact_message');
    expect(msgs[0].data.rssi).toBe(-70);
    expect(msgs[1].data.rssi).toBeUndefined();
  });
});
