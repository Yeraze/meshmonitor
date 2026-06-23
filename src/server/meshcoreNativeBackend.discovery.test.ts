/**
 * Tests for the active node-discovery path in MeshCoreNativeBackend.
 *
 * Covers:
 *   1. `discover_nodes` builds the correct CMD_SEND_CONTROL_DATA (55) frame
 *      with a CTL_TYPE_NODE_DISCOVER_REQ (0x80, prefix_only=false) control
 *      payload: [55, 0x80, filter, tag(4B LE)].
 *   2. The 0x8E (PUSH_CODE_CONTROL_DATA) handler parses NODE_DISCOVER_RESP
 *      frames whose tag matches the pending request, emits `node_discovered`,
 *      and auto-adds the node on the device via addOrUpdateContact.
 *   3. Responses with a non-matching tag are ignored.
 *   4. Prefix-only responses (key < 32 bytes) are not auto-added.
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
  BinaryResponse: 0x8c, ControlData: 0x8e,
};
const StatsTypes = { Core: 0, Radio: 1, Packets: 2 };
const SelfAdvertTypes = { ZeroHop: 0, Flood: 1 };
const BinaryRequestTypes = { GetTelemetryData: 0x03 };
const AdvType = { None: 0, Chat: 1, Repeater: 2, Room: 3 };
const TxtTypes = { Plain: 0, CliData: 1, SignedPlain: 2 };

class MockConnection extends EventEmitter {
  sentFrames: Uint8Array[] = [];
  addOrUpdateContact = vi.fn().mockResolvedValue(undefined);
  /** Reply bytes a `request_regions` (CMD 57) frame should produce. */
  regionsResponseData: Uint8Array | null = null;
  async connect() { /* no-op */ }
  async close() { /* no-op */ }
  async getSelfInfo() {
    return { type: AdvType.Chat, publicKey: Uint8Array.from(Array(32).fill(0)), name: 'TestNode' };
  }
  sendToRadioFrame(frame: Uint8Array) {
    this.sentFrames.push(frame);
    if (frame[0] === 57) {
      // CMD_SEND_ANON_REQ (regions): reply with a Sent ack (carrying the tag)
      // then the BinaryResponse push with the canned region bytes.
      const tag = 0x99;
      setImmediate(() => {
        this.emit(ResponseCodes.Sent, { expectedAckCrc: tag, estTimeout: 1000 });
        this.emit(PushCodes.BinaryResponse, { reserved: 0, tag, responseData: this.regionsResponseData ?? new Uint8Array() });
      });
      return;
    }
    // discover_nodes (CMD 55) and others: ack with OK on the next tick.
    setImmediate(() => this.emit(ResponseCodes.Ok));
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
    Packet: {} as any,
  });
}

async function connectedBackend(): Promise<{ backend: MeshCoreNativeBackend; conn: MockConnection; events: any[] }> {
  const backend = new MeshCoreNativeBackend('src-discover', {
    connectionType: 'serial',
    serialPort: '/dev/ttyUSB0',
  });
  const events: any[] = [];
  backend.on('event', (e) => events.push(e));
  await backend.connect();
  const conn = (backend as any).connection as MockConnection;
  return { backend, conn, events };
}

/** Build a NODE_DISCOVER_RESP 0x8E push frame. */
function buildDiscoverResp(opts: {
  snrX4: number; rssi: number; pathLen: number;
  nodeType: number; responderSnrX4: number; tag: number; pubkey: Uint8Array;
}): Uint8Array {
  const head = [
    0x8e,
    opts.snrX4 & 0xff,
    opts.rssi & 0xff,
    opts.pathLen & 0xff,
    (0x90 | (opts.nodeType & 0x0f)) & 0xff,
    opts.responderSnrX4 & 0xff,
    opts.tag & 0xff,
    (opts.tag >>> 8) & 0xff,
    (opts.tag >>> 16) & 0xff,
    (opts.tag >>> 24) & 0xff,
  ];
  return Uint8Array.from([...head, ...opts.pubkey]);
}

/** Build an inbound NODE_DISCOVER_REQ 0x8E push frame (what we'd receive). */
function buildDiscoverReq(opts: {
  snrX4: number; filter: number; tag: number; prefixOnly?: boolean;
}): Uint8Array {
  return Uint8Array.from([
    0x8e,
    opts.snrX4 & 0xff,
    0x00, // rssi
    0xff, // path_len
    (0x80 | (opts.prefixOnly ? 1 : 0)) & 0xff, // CTL_TYPE_NODE_DISCOVER_REQ
    opts.filter & 0xff,
    opts.tag & 0xff,
    (opts.tag >>> 8) & 0xff,
    (opts.tag >>> 16) & 0xff,
    (opts.tag >>> 24) & 0xff,
  ]);
}

describe('MeshCoreNativeBackend — node discovery', () => {
  beforeEach(() => installMockModule());
  afterEach(() => __setMeshCoreModule(null));

  it('discover_nodes builds [55, 0x80, filter, tag(LE)] and sets the pending tag', async () => {
    const { backend, conn } = await connectedBackend();
    const res = await backend.sendCommand('discover_nodes', { filter: 0x0c, tag: 0x11223344 });
    expect(res.success).toBe(true);

    const frame = conn.sentFrames.at(-1)!;
    expect(Array.from(frame)).toEqual([
      55,         // CMD_SEND_CONTROL_DATA
      0x80,       // CTL_TYPE_NODE_DISCOVER_REQ, prefix_only=false
      0x0c,       // filter = Repeater|Room
      0x44, 0x33, 0x22, 0x11, // tag, little-endian
    ]);
    expect((backend as any).pendingDiscoverTag).toBe(0x11223344);
  });

  it('emits node_discovered and auto-adds when a matching-tag full-key response arrives', async () => {
    const { backend, conn, events } = await connectedBackend();
    const tag = 0xa1b2c3d4;
    await backend.sendCommand('discover_nodes', { filter: 0x0c, tag });

    const pubkey = Uint8Array.from(Array.from({ length: 32 }, (_, i) => i + 1));
    conn.emit('rx', buildDiscoverResp({
      snrX4: 25, rssi: -42 & 0xff, pathLen: 0xff,
      nodeType: AdvType.Repeater, responderSnrX4: 16, tag, pubkey,
    }));

    const ev = events.find((e) => e.event_type === 'node_discovered');
    expect(ev).toBeDefined();
    expect(ev.data.adv_type).toBe(AdvType.Repeater);
    expect(ev.data.snr).toBe(6.25); // 25 / 4
    expect(ev.data.public_key).toBe(
      Array.from(pubkey).map((b) => b.toString(16).padStart(2, '0')).join(''),
    );

    // Auto-added on the device with the full key, type, empty name, flood path.
    expect(conn.addOrUpdateContact).toHaveBeenCalledTimes(1);
    const [keyArg, typeArg, flagsArg, outPathLenArg] = conn.addOrUpdateContact.mock.calls[0];
    expect(Array.from(keyArg as Uint8Array)).toEqual(Array.from(pubkey));
    expect(typeArg).toBe(AdvType.Repeater);
    expect(flagsArg).toBe(0);
    expect(outPathLenArg).toBe(0xff);
  });

  it('ignores responses whose tag does not match the pending request', async () => {
    const { backend, conn, events } = await connectedBackend();
    await backend.sendCommand('discover_nodes', { filter: 0x02, tag: 0x00000001 });

    conn.emit('rx', buildDiscoverResp({
      snrX4: 10, rssi: -50 & 0xff, pathLen: 0xff,
      nodeType: AdvType.Chat, responderSnrX4: 8, tag: 0x99999999,
      pubkey: Uint8Array.from(Array(32).fill(7)),
    }));

    expect(events.find((e) => e.event_type === 'node_discovered')).toBeUndefined();
    expect(conn.addOrUpdateContact).not.toHaveBeenCalled();
  });

  it('does not auto-add a prefix-only (short key) response', async () => {
    const { backend, conn, events } = await connectedBackend();
    const tag = 0x12345678;
    await backend.sendCommand('discover_nodes', { filter: 0x02, tag });

    // prefix_only response carries only 8 key bytes (< 32) → cannot register.
    conn.emit('rx', buildDiscoverResp({
      snrX4: 12, rssi: -33 & 0xff, pathLen: 0xff,
      nodeType: AdvType.Chat, responderSnrX4: 4, tag,
      pubkey: Uint8Array.from(Array(8).fill(0xaa)),
    }));

    expect(events.find((e) => e.event_type === 'node_discovered')).toBeUndefined();
    expect(conn.addOrUpdateContact).not.toHaveBeenCalled();
  });
});

describe('MeshCoreNativeBackend — discovery responder', () => {
  beforeEach(() => installMockModule());
  afterEach(() => __setMeshCoreModule(null));

  // Our mock self is a Chat (companion) node with an all-zero 32-byte key.
  const selfTypeBit = 1 << AdvType.Chat; // 0x02

  it('does not respond when discoverable is disabled', async () => {
    const { conn } = await connectedBackend();
    conn.emit('rx', buildDiscoverReq({ snrX4: 20, filter: 0x1e, tag: 0x11111111 }));
    expect(conn.sentFrames.some((f) => f[0] === 55)).toBe(false);
  });

  it('responds with NODE_DISCOVER_RESP when enabled and the filter matches our type', async () => {
    const { backend, conn } = await connectedBackend();
    backend.setRespondToDiscovery(true);
    conn.emit('rx', buildDiscoverReq({ snrX4: 24, filter: selfTypeBit, tag: 0xaabbccdd }));

    const resp = conn.sentFrames.find((f) => f[0] === 55);
    expect(resp).toBeDefined();
    expect(resp![1]).toBe(0x90 | AdvType.Chat); // 0x91
    expect(resp![2]).toBe(24); // echoed inbound SNR byte
    // tag echoed (LE)
    expect(Array.from(resp!.slice(3, 7))).toEqual([0xdd, 0xcc, 0xbb, 0xaa]);
    // full 32-byte key (prefix_only=false)
    expect(resp!.length).toBe(7 + 32);
  });

  it('ignores a request whose filter excludes our node type', async () => {
    const { backend, conn } = await connectedBackend();
    backend.setRespondToDiscovery(true);
    // 0x0c = Repeater|Room only — our Chat bit (0x02) is not set
    conn.emit('rx', buildDiscoverReq({ snrX4: 10, filter: 0x0c, tag: 0x22222222 }));
    expect(conn.sentFrames.some((f) => f[0] === 55)).toBe(false);
  });

  it('returns an 8-byte key when the request asks for prefix_only', async () => {
    const { backend, conn } = await connectedBackend();
    backend.setRespondToDiscovery(true);
    conn.emit('rx', buildDiscoverReq({ snrX4: 5, filter: selfTypeBit, tag: 0x33333333, prefixOnly: true }));
    const resp = conn.sentFrames.find((f) => f[0] === 55);
    expect(resp).toBeDefined();
    expect(resp!.length).toBe(7 + 8);
  });

  it('rate-limits to 4 responses per window', async () => {
    const { backend, conn } = await connectedBackend();
    backend.setRespondToDiscovery(true);
    for (let i = 0; i < 6; i++) {
      conn.emit('rx', buildDiscoverReq({ snrX4: 12, filter: selfTypeBit, tag: 0x40000000 + i }));
    }
    expect(conn.sentFrames.filter((f) => f[0] === 55).length).toBe(4);
  });

  it('request_regions sends [57, pubkey, 0x01, 0x00] and parses clock + region names (#3667)', async () => {
    const { backend, conn } = await connectedBackend();
    // clock(4 LE)=1 + "muenchen,bayern,*" + NUL + trailing junk (must be ignored)
    conn.regionsResponseData = Uint8Array.from([
      1, 0, 0, 0,
      ...Buffer.from('muenchen,bayern,*', 'ascii'),
      0,
      ...Buffer.from('JUNK', 'ascii'),
    ]);

    const res = await backend.sendCommand('request_regions', { public_key: 'aa'.repeat(32) });
    expect(res.success).toBe(true);

    // Outbound frame layout: CMD 57 + 32-byte pubkey + req_type 0x01 + reply_path_len 0.
    const frame = conn.sentFrames.at(-1)!;
    expect(frame.length).toBe(1 + 32 + 2);
    expect(frame[0]).toBe(57);
    expect(Array.from(frame.slice(1, 33))).toEqual(Array(32).fill(0xaa));
    expect(frame[33]).toBe(0x01);
    expect(frame[34]).toBe(0x00);

    // Parsed reply: clock from the first 4 bytes, names split on ',' up to the
    // NUL. The wildcard '*' is preserved here (the manager filters it).
    expect(res.data.clock).toBe(1);
    expect(res.data.regions).toEqual(['muenchen', 'bayern', '*']);
  });
});
