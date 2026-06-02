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
  ControlData: 0x8e,
};
const StatsTypes = { Core: 0, Radio: 1, Packets: 2 };
const SelfAdvertTypes = { ZeroHop: 0, Flood: 1 };
const BinaryRequestTypes = { GetTelemetryData: 0x03 };
const AdvType = { None: 0, Chat: 1, Repeater: 2, Room: 3 };
const TxtTypes = { Plain: 0, CliData: 1, SignedPlain: 2 };

class MockConnection extends EventEmitter {
  sentFrames: Uint8Array[] = [];
  addOrUpdateContact = vi.fn().mockResolvedValue(undefined);
  async connect() { /* no-op */ }
  async close() { /* no-op */ }
  async getSelfInfo() {
    return { type: AdvType.Chat, publicKey: Uint8Array.from(Array(32).fill(0)), name: 'TestNode' };
  }
  // The discover_nodes command sends the frame then waits for an OK ack.
  sendToRadioFrame(frame: Uint8Array) {
    this.sentFrames.push(frame);
    // Ack on the next tick so the awaiting command resolves.
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
