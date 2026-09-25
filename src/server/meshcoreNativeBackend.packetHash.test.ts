/**
 * LogRxData → recv correlation and packet hash (#5357).
 *
 * These tests drive the backend with REAL MeshCore wire frames parsed by the
 * real meshcore.js `Packet`, so every packet hash below is the genuine
 * `calculateMeshCorePacketHash` of the frame — the value that reaches
 * `{{ trigger.packetHash }}`.
 *
 *   - Channel messages are matched by decrypting the buffered GRP_TXT frame
 *     and requiring its timestamp + "Name: text" body to equal the recv's.
 *     Nothing is attached when no frame verifies.
 *   - DMs are matched best-effort by src_hash, with path_len / SNR breaking
 *     ties; duplicate flood copies of a consumed packet are dropped.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { Packet } from '@liamcottle/meshcore.js';
import { MeshCoreNativeBackend, __setMeshCoreModule } from './meshcoreNativeBackend.js';
import { encodeGroupTextPayload, MESHCORE_PUBLIC_CHANNEL_SECRET } from './utils/meshcoreGroupEcho.js';
import { calculateMeshCorePacketHash } from './services/meshcoreObserverPacket.js';

const ResponseCodes = {
  Ok: 0, Err: 1, ContactsStart: 2, Contact: 3, EndOfContacts: 4,
  SelfInfo: 5, Sent: 6, ContactMsgRecv: 7, ChannelMsgRecv: 8,
  CurrTime: 9, NoMoreMessages: 10, Stats: 24,
};
const PushCodes = {
  Advert: 0x80, PathUpdated: 0x81, MsgWaiting: 0x83, NewAdvert: 0x8a,
  LogRxData: 0x88,
};
const TxtTypes = { Plain: 0, CliData: 1, SignedPlain: 2 };

class MockConnection extends EventEmitter {
  async connect() { /* no-op */ }
  async close() { /* no-op */ }
  async getSelfInfo() {
    // All-zero pubkey → our DM dest_hash byte is 0x00.
    return { type: 1, publicKey: Uint8Array.from(Array(32).fill(0)), name: 'TestNode' };
  }
}

function installMockModule(): void {
  __setMeshCoreModule({
    NodeJSSerialConnection: MockConnection as any,
    TCPConnection: MockConnection as any,
    Constants: {
      ResponseCodes, PushCodes, TxtTypes,
      StatsTypes: { Core: 0, Radio: 1, Packets: 2 },
      SelfAdvertTypes: { ZeroHop: 0, Flood: 1 },
      BinaryRequestTypes: { GetTelemetryData: 0x03 },
      AdvType: { None: 0, Chat: 1, Repeater: 2, Room: 3 },
    } as any,
    CayenneLpp: { parse: () => [] } as any,
    Packet: Packet as any,
  });
}

const ROUTE_FLOOD = 0x01;
const ROUTE_DIRECT = 0x02;
const TXT_MSG = 0x02;
const GRP_TXT = 0x05;

const SECRET_0 = MESHCORE_PUBLIC_CHANNEL_SECRET;
const SECRET_1 = Uint8Array.from(Buffer.from('00112233445566778899aabbccddeeff', 'hex'));
const FOREIGN_SECRET = Uint8Array.from(Buffer.from('ffeeddccbbaa99887766554433221100', 'hex'));

/** Real wire frame: [header][path_len][path…][payload…] (no transport codes). */
function frame(route: number, payloadType: number, path: number[], payload: Uint8Array | number[]): Uint8Array {
  return Uint8Array.from([(payloadType << 2) | route, path.length, ...path, ...payload]);
}

function grpPayload(secret: Uint8Array, sender: string, text: string, ts: number): Uint8Array {
  return Uint8Array.from(Buffer.from(encodeGroupTextPayload(secret, sender, text, ts), 'hex'));
}

/** TXT_MSG payload to us (dest 0x00) from `src`: [dest][src][MAC:2][ciphertext:16]. */
function dmPayload(src: number, fill: number): Uint8Array {
  return Uint8Array.from([0x00, src, fill, fill, ...Array(16).fill(fill)]);
}

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const hashOf = (b: Uint8Array): string => calculateMeshCorePacketHash(hex(b));

async function connectedBackend(
  resolver: ((idx: number) => Uint8Array | null) | null = (idx) => (idx === 0 ? SECRET_0 : idx === 1 ? SECRET_1 : null),
): Promise<{ backend: MeshCoreNativeBackend; conn: MockConnection; events: any[] }> {
  const backend = new MeshCoreNativeBackend('src-hash', { connectionType: 'serial', serialPort: '/dev/ttyUSB0' });
  const events: any[] = [];
  backend.on('event', (e) => events.push(e));
  backend.setChannelSecretResolver(resolver);
  await backend.connect();
  return { backend, conn: (backend as any).connection as MockConnection, events };
}

const rx = (conn: MockConnection, raw: Uint8Array, snr = 5, rssi = -60) =>
  conn.emit(PushCodes.LogRxData, { lastSnr: snr, lastRssi: rssi, raw });

const channelRecv = (conn: MockConnection, channelIdx: number, text: string, ts: number, pathLen = 1) =>
  conn.emit(ResponseCodes.ChannelMsgRecv, { channelIdx, text, senderTimestamp: ts, pathLen, txtType: 0 });

const dmRecv = (conn: MockConnection, src: number, pathLen: number, extra: Record<string, unknown> = {}) =>
  conn.emit(ResponseCodes.ContactMsgRecv, {
    pubKeyPrefix: Uint8Array.from([src, 1, 2, 3, 4, 5]),
    text: 'hi', senderTimestamp: 1700000000, pathLen, txtType: TxtTypes.Plain, ...extra,
  });

const pending = (backend: MeshCoreNativeBackend): unknown[] => (backend as any).pendingTxtMsgPaths;

describe('MeshCoreNativeBackend — channel packet hash via decrypt-and-verify (#5357)', () => {
  beforeEach(() => installMockModule());
  afterEach(() => __setMeshCoreModule(null));

  it('attaches the verified frame and drops its duplicate flood copies', async () => {
    const { backend, conn, events } = await connectedBackend();
    const payload = grpPayload(SECRET_0, 'Alice', 'hello mesh', 1700000100);
    const copy1 = frame(ROUTE_FLOOD, GRP_TXT, [0xa1], payload);
    const copy2 = frame(ROUTE_FLOOD, GRP_TXT, [0xa1, 0xb2], payload);
    rx(conn, copy1, 6.5, -50);
    rx(conn, copy2, 2, -90);
    channelRecv(conn, 0, 'Alice: hello mesh', 1700000100);

    const msg = events.find((e) => e.event_type === 'channel_message');
    expect(msg.data.packet_hash).toBe(hashOf(copy1));
    expect(msg.data.packet_hash).toMatch(/^[0-9A-F]{16}$/);
    // Every copy of one packet shares the hash (path bytes aren't hashed).
    expect(hashOf(copy2)).toBe(hashOf(copy1));
    // The oldest (decoded) copy supplies path/SNR/RSSI/raw.
    expect(msg.data.path_hops).toEqual(['a1']);
    expect(msg.data.snr).toBe(6.5);
    expect(msg.data.rssi).toBe(-50);
    expect(msg.data.raw_hex).toBe(hex(copy1));
    // The duplicate is gone, and a later copy isn't buffered at all.
    expect(pending(backend)).toHaveLength(0);
    rx(conn, frame(ROUTE_FLOOD, GRP_TXT, [0xa1, 0xb2, 0xc3], payload));
    expect(pending(backend)).toHaveLength(0);
  });

  it('matches two channel messages whose recvs arrive out of buffer order', async () => {
    const { conn, events } = await connectedBackend();
    const a = frame(ROUTE_FLOOD, GRP_TXT, [0xc1], grpPayload(SECRET_0, 'A', 'first', 1700000001));
    const b = frame(ROUTE_FLOOD, GRP_TXT, [0xc2], grpPayload(SECRET_1, 'B', 'second', 1700000002));
    rx(conn, a, 1);
    rx(conn, b, 2);
    channelRecv(conn, 1, 'B: second', 1700000002);
    channelRecv(conn, 0, 'A: first', 1700000001);

    const msgs = events.filter((e) => e.event_type === 'channel_message');
    expect(msgs[0].data.packet_hash).toBe(hashOf(b));
    expect(msgs[0].data.path_hops).toEqual(['c2']);
    expect(msgs[1].data.packet_hash).toBe(hashOf(a));
    expect(msgs[1].data.path_hops).toEqual(['c1']);
  });

  it('never attaches a GRP_TXT for a channel we do not hold', async () => {
    const { backend, conn, events } = await connectedBackend();
    // Overheard traffic on a foreign channel, same timestamp/text as ours.
    rx(conn, frame(ROUTE_FLOOD, GRP_TXT, [0xd1], grpPayload(FOREIGN_SECRET, 'Zed', 'hi', 1700000003)));
    channelRecv(conn, 0, 'Zed: hi', 1700000003);
    // Channel slot 2 has no secret at all.
    channelRecv(conn, 2, 'Zed: hi', 1700000003);

    const msgs = events.filter((e) => e.event_type === 'channel_message');
    for (const m of msgs) {
      expect(m.data.packet_hash).toBeUndefined();
      expect(m.data.path_hops).toBeUndefined();
      expect(m.data.snr).toBeUndefined();
      expect(m.data.raw_hex).toBeUndefined();
    }
    // Left for the age GC, not consumed.
    expect(pending(backend)).toHaveLength(1);
  });

  it('attaches nothing when no buffered frame verifies (e.g. a backlog message)', async () => {
    const { conn, events } = await connectedBackend();
    // A live frame on our channel, but for a different message.
    rx(conn, frame(ROUTE_FLOOD, GRP_TXT, [0xe1], grpPayload(SECRET_0, 'Bob', 'live', 1700000010)));
    // Backlog message synced after reconnect: no LogRxData of its own.
    channelRecv(conn, 0, 'Carol: from the queue', 1699999000);
    // Same text, wrong timestamp — must not verify either.
    channelRecv(conn, 0, 'Bob: live', 1700000011);

    const msgs = events.filter((e) => e.event_type === 'channel_message');
    expect(msgs).toHaveLength(2);
    for (const m of msgs) {
      expect(m.data.packet_hash).toBeUndefined();
      expect(m.data.path_hops).toBeUndefined();
      expect(m.data.snr).toBeUndefined();
      expect(m.data.rssi).toBeUndefined();
    }
  });

  it('attaches nothing to channel messages when no secret resolver is set', async () => {
    const { conn, events } = await connectedBackend(null);
    rx(conn, frame(ROUTE_FLOOD, GRP_TXT, [0xf1], grpPayload(SECRET_0, 'A', 'x', 1700000020)));
    channelRecv(conn, 0, 'A: x', 1700000020);
    const msg = events.find((e) => e.event_type === 'channel_message');
    expect(msg.data.packet_hash).toBeUndefined();
    expect(msg.data.path_hops).toBeUndefined();
  });

  it('tolerates a recv text cut short by the companion frame cap', async () => {
    const { conn, events } = await connectedBackend();
    const longText = 'x'.repeat(170);
    const f = frame(ROUTE_FLOOD, GRP_TXT, [0x11], grpPayload(SECRET_0, 'Al', longText, 1700000030));
    rx(conn, f);
    // Frame cap: the recv carries only the first 164 bytes of "Al: xxx…".
    channelRecv(conn, 0, `Al: ${longText}`.slice(0, 164), 1700000030);
    expect(events.find((e) => e.event_type === 'channel_message').data.packet_hash).toBe(hashOf(f));
  });
});

describe('MeshCoreNativeBackend — DM packet hash, best-effort (#5357)', () => {
  beforeEach(() => installMockModule());
  afterEach(() => __setMeshCoreModule(null));

  it('dedupes flood copies so the next DM from the same sender gets its own frame', async () => {
    const { backend, conn, events } = await connectedBackend();
    const first = dmPayload(0x22, 0x01);
    const second = dmPayload(0x22, 0x02);
    const a1 = frame(ROUTE_FLOOD, TXT_MSG, [0xa1], first);
    const a2 = frame(ROUTE_FLOOD, TXT_MSG, [0xa1, 0xb2], first); // flood copy of A
    // Same hop count as A's leftover copy, so path_len alone can't tell them apart.
    const b1 = frame(ROUTE_FLOOD, TXT_MSG, [0xc3, 0xd4], second);
    rx(conn, a1, 7);
    rx(conn, a2, 1);
    rx(conn, b1, 4);
    dmRecv(conn, 0x22, 1);
    dmRecv(conn, 0x22, 2);

    const msgs = events.filter((e) => e.event_type === 'contact_message');
    expect(msgs[0].data.packet_hash).toBe(hashOf(a1));
    expect(msgs[0].data.path_hops).toEqual(['a1']);
    // Without dedup this would be A's second copy.
    expect(msgs[1].data.packet_hash).toBe(hashOf(b1));
    expect(msgs[1].data.path_hops).toEqual(['c3', 'd4']);
    expect(pending(backend)).toHaveLength(0);
  });

  it('does not buffer a late flood copy of a DM already consumed', async () => {
    const { backend, conn, events } = await connectedBackend();
    const p = dmPayload(0x33, 0x05);
    rx(conn, frame(ROUTE_FLOOD, TXT_MSG, [0x01], p));
    dmRecv(conn, 0x33, 1);
    rx(conn, frame(ROUTE_FLOOD, TXT_MSG, [0x01, 0x02], p)); // arrives after the recv
    expect(pending(backend)).toHaveLength(0);
    dmRecv(conn, 0x33, 2);
    const msgs = events.filter((e) => e.event_type === 'contact_message');
    expect(msgs[1].data.packet_hash).toBeUndefined();
  });

  it('breaks a src_hash tie on the recv path_len (flood hop byte, 0xFF = direct)', async () => {
    const { conn, events } = await connectedBackend();
    const twoHop = frame(ROUTE_FLOOD, TXT_MSG, [0x0a, 0x0b], dmPayload(0x44, 0x01));
    const oneHop = frame(ROUTE_FLOOD, TXT_MSG, [0x0c], dmPayload(0x44, 0x02));
    const direct = frame(ROUTE_DIRECT, TXT_MSG, [], dmPayload(0x44, 0x03));
    rx(conn, twoHop);
    rx(conn, oneHop);
    rx(conn, direct);
    dmRecv(conn, 0x44, 0xff);
    dmRecv(conn, 0x44, 1);
    dmRecv(conn, 0x44, 2);

    const msgs = events.filter((e) => e.event_type === 'contact_message');
    expect(msgs[0].data.packet_hash).toBe(hashOf(direct));
    expect(msgs[1].data.packet_hash).toBe(hashOf(oneHop));
    expect(msgs[2].data.packet_hash).toBe(hashOf(twoHop));
  });

  it('breaks a remaining tie on the recv SNR when the frame carries one (v3)', async () => {
    const { conn, events } = await connectedBackend();
    const weak = frame(ROUTE_FLOOD, TXT_MSG, [0x0a], dmPayload(0x55, 0x01));
    const strong = frame(ROUTE_FLOOD, TXT_MSG, [0x0b], dmPayload(0x55, 0x02));
    rx(conn, weak, -4);
    rx(conn, strong, 9.25);
    dmRecv(conn, 0x55, 1, { snr: 9.25 });
    expect(events.find((e) => e.event_type === 'contact_message').data.packet_hash).toBe(hashOf(strong));
  });

  it('falls back to the oldest same-sender frame when nothing breaks the tie', async () => {
    const { conn, events } = await connectedBackend();
    const older = frame(ROUTE_FLOOD, TXT_MSG, [0x0a], dmPayload(0x66, 0x01));
    rx(conn, older);
    rx(conn, frame(ROUTE_FLOOD, TXT_MSG, [0x0b], dmPayload(0x66, 0x02)));
    dmRecv(conn, 0x66, 5); // path_len matches neither
    expect(events.find((e) => e.event_type === 'contact_message').data.packet_hash).toBe(hashOf(older));
  });

  it('attaches no hash when no buffered DM matches the sender', async () => {
    const { conn, events } = await connectedBackend();
    rx(conn, frame(ROUTE_FLOOD, TXT_MSG, [0x0a], dmPayload(0x77, 0x01)));
    dmRecv(conn, 0x78, 1);
    const msg = events.find((e) => e.event_type === 'contact_message');
    expect(msg.data.packet_hash).toBeUndefined();
    expect(msg.data.path_hops).toBeUndefined();
  });
});
