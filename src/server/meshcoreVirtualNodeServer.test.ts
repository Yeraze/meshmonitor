import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { Socket } from 'net';
import { Connection, Constants } from '@liamcottle/meshcore.js';
import { MeshCoreVirtualNodeServer, type MeshCoreVirtualNodeManager } from './meshcoreVirtualNodeServer.js';
import {
  CommandCodes,
  ResponseCodes,
  ErrorCodes,
  PushCodes,
  FRAME_APP_TO_NODE,
  FRAME_NODE_TO_APP,
  SUPPORTED_COMPANION_PROTOCOL_VERSION,
  degreesToFixed,
} from './meshcoreCompanionCodec.js';
import type { MeshCoreNode, MeshCoreContact, MeshCoreMessage } from './meshcoreManager.js';

// Audit logging is fire-and-forget; stub it so the test doesn't touch the DB.
vi.mock('../services/database.js', () => ({
  default: { auditLogAsync: vi.fn().mockResolvedValue(undefined) },
}));

const LOCAL_NODE: MeshCoreNode = {
  publicKey: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
  name: 'Phase0 Node',
  advType: Constants.AdvType.Chat,
  txPower: 20,
  maxTxPower: 30,
  radioFreq: 917.375, // MHz
  radioBw: 250, // kHz
  radioSf: 11,
  radioCr: 5,
  latitude: 29.7604,
  longitude: -95.3698,
  manualAddContacts: 1,
};

const SAMPLE_CONTACTS: MeshCoreContact[] = [
  {
    publicKey: 'b1'.repeat(32),
    advName: 'Repeater North',
    advType: Constants.AdvType.Repeater,
    latitude: 40.1,
    longitude: -105.2,
    lastAdvert: 1_750_000_000,
    lastSeen: 1_750_000_500,
    pathLen: 2,
    outPath: 'a3,7f',
  },
];

/** A fake manager backed by a real EventEmitter so the server can subscribe. */
class FakeManager extends EventEmitter implements MeshCoreVirtualNodeManager {
  readonly sourceId = 'src-test';
  private localNode: MeshCoreNode | null;
  private contacts: MeshCoreContact[];
  constructor(localNode: MeshCoreNode | null = LOCAL_NODE, contacts = SAMPLE_CONTACTS) {
    super();
    this.localNode = localNode;
    this.contacts = contacts;
  }
  sendMessageMock = vi.fn().mockResolvedValue(true);
  sendMessageWithResultMock = vi.fn().mockResolvedValue({ ok: true });
  // Config-mutation mocks (issue #3904).
  setNameMock = vi.fn().mockResolvedValue(true);
  setRadioMock = vi.fn().mockResolvedValue(true);
  setTxPowerMock = vi.fn().mockResolvedValue(true);
  setCoordsMock = vi.fn().mockResolvedValue(true);
  setChannelMock = vi.fn().mockResolvedValue(undefined);
  setOtherParamsMock = vi.fn().mockResolvedValue(true);
  isConnected() { return this.localNode !== null; }
  getLocalNode() { return this.localNode; }
  getContacts() { return this.contacts; }
  sendMessage(text: string, toPublicKey?: string, channelIdx?: number) {
    return this.sendMessageMock(text, toPublicKey, channelIdx) as Promise<boolean>;
  }
  sendMessageWithResult(text: string, toPublicKey?: string, channelIdx?: number) {
    return this.sendMessageWithResultMock(text, toPublicKey, channelIdx) as Promise<{ ok: boolean; expectedAckCrc?: number; estTimeout?: number }>;
  }
  setName(name: string) { return this.setNameMock(name) as Promise<boolean>; }
  setRadio(freq: number, bw: number, sf: number, cr: number) {
    return this.setRadioMock(freq, bw, sf, cr) as Promise<boolean>;
  }
  setTxPower(power: number) { return this.setTxPowerMock(power) as Promise<boolean>; }
  setCoords(lat: number, lon: number) { return this.setCoordsMock(lat, lon) as Promise<boolean>; }
  setChannel(idx: number, name: string, secretHex: string, scope?: string | null) {
    return this.setChannelMock(idx, name, secretHex, scope) as Promise<void>;
  }
  setOtherParams(params: {
    manualAddContacts: number;
    telemetryModeBase: number;
    telemetryModeLoc: number;
    telemetryModeEnv: number;
    advLocPolicy: number;
  }) {
    return this.setOtherParamsMock(params) as Promise<boolean>;
  }
  emitMessage(msg: MeshCoreMessage) { this.emit('message', msg); }
  emitSendConfirmed(data: { ackCode: number; roundTripMs: number }) { this.emit('send_confirmed', data); }
}

const CHANNELS_DB = {
  channels: {
    getAllChannels: vi.fn().mockResolvedValue([
      { id: 0, name: 'Public', psk: Buffer.from('0123456789abcdef0123456789abcdef', 'hex').toString('base64') },
    ]),
  },
};

function makeManager(overrides: Partial<MeshCoreVirtualNodeManager> = {}): MeshCoreVirtualNodeManager {
  const base = new FakeManager(
    'getLocalNode' in overrides ? (overrides.getLocalNode as () => MeshCoreNode | null)() : LOCAL_NODE,
  );
  return Object.assign(base, overrides) as MeshCoreVirtualNodeManager;
}

/** Frame an app→node command (the byte layout the MeshCore app would send). */
function frameCommand(payload: number[]): Buffer {
  const header = Buffer.alloc(3);
  header[0] = FRAME_APP_TO_NODE;
  header.writeUInt16LE(payload.length, 1);
  return Buffer.concat([header, Buffer.from(payload)]);
}

/**
 * Tiny client: connects, lets you send command frames, and resolves the next
 * complete node→app (0x3e) response frame's payload (response code byte first).
 */
class TestClient {
  private socket = new Socket();
  private buffer = Buffer.alloc(0);
  private waiters: Array<(payload: Buffer) => void> = [];

  async connect(port: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.socket.once('error', reject);
      this.socket.connect(port, '127.0.0.1', () => resolve());
    });
    this.socket.on('data', (data) => this.onData(data));
  }

  private onData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 3) {
      if (this.buffer[0] !== FRAME_NODE_TO_APP) {
        this.buffer = this.buffer.subarray(1);
        continue;
      }
      const len = this.buffer.readUInt16LE(1);
      if (this.buffer.length < 3 + len) break;
      const payload = Buffer.from(this.buffer.subarray(3, 3 + len));
      this.buffer = this.buffer.subarray(3 + len);
      this.waiters.shift()?.(payload);
    }
  }

  /** Send a command and await the next response payload. */
  request(payload: number[]): Promise<Buffer> {
    const p = new Promise<Buffer>((resolve) => this.waiters.push(resolve));
    this.socket.write(frameCommand(payload));
    return p;
  }

  /** Await the next N response payloads (for commands that reply with several frames). */
  expectFrames(n: number): Promise<Buffer[]> {
    return Promise.all(Array.from({ length: n }, () => new Promise<Buffer>((resolve) => this.waiters.push(resolve))));
  }

  send(payload: number[]): void {
    this.socket.write(frameCommand(payload));
  }

  close(): void {
    this.socket.destroy();
  }
}

describe('MeshCoreVirtualNodeServer — Phase 0 handshake', () => {
  let server: MeshCoreVirtualNodeServer;
  let client: TestClient;
  let manager: FakeManager;

  beforeEach(async () => {
    manager = new FakeManager();
    server = new MeshCoreVirtualNodeServer({ port: 0, manager, databaseService: CHANNELS_DB });
    await server.start();
    client = new TestClient();
    await client.connect(server.getListeningPort()!);
  });

  afterEach(async () => {
    client.close();
    await server.stop();
  });

  it('replies to AppStart with SelfInfo carrying the real node identity', async () => {
    const payload = await client.request([CommandCodes.AppStart, 1, 0, 0, 0, 0, 0, 0]); // appVer + 6 reserved
    expect(payload[0]).toBe(ResponseCodes.SelfInfo);
    // name is the remainder of the frame after the fixed SelfInfo fields
    expect(payload.subarray(-LOCAL_NODE.name.length).toString('utf8')).toBe('Phase0 Node');
  });

  it('reports the real manualAddContacts in SelfInfo instead of hardcoding 0 (#3904 follow-up)', async () => {
    // LOCAL_NODE.manualAddContacts = 1; decode the SelfInfo via meshcore.js's own
    // parser and assert the field round-trips rather than being pinned to 0.
    const payload = await client.request([CommandCodes.AppStart, 1, 0, 0, 0, 0, 0, 0]);
    expect(payload[0]).toBe(ResponseCodes.SelfInfo);
    const decoded = await new Promise<any>((resolve) => {
      const conn: any = new (Connection as any)();
      conn.once(ResponseCodes.SelfInfo, (event: any) => resolve(event));
      conn.onFrameReceived(new Uint8Array(payload));
    });
    expect(decoded.manualAddContacts).toBe(1);
  });

  it('replies to GetDeviceTime with a plausible CurrTime', async () => {
    const before = Math.floor(Date.now() / 1000);
    const payload = await client.request([CommandCodes.GetDeviceTime]);
    expect(payload[0]).toBe(ResponseCodes.CurrTime);
    const epoch = payload.readUInt32LE(1);
    expect(epoch).toBeGreaterThanOrEqual(before);
    expect(epoch).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 1);
  });

  it('replies to DeviceQuery with DeviceInfo advertising the supported protocol version', async () => {
    const payload = await client.request([CommandCodes.DeviceQuery, 1]);
    expect(payload[0]).toBe(ResponseCodes.DeviceInfo);
    // Byte 1 is the companion protocol version the app must use to talk to us.
    expect(payload.readInt8(1)).toBe(SUPPORTED_COMPANION_PROTOCOL_VERSION);
  });

  it('pins DeviceInfo protocol version to v1 even when the real node reports a higher firmwareVer (regression #3705)', async () => {
    // Once the manager's background deviceQuery() caches the real node's
    // firmware-version byte, that value must NOT leak into the VN's DeviceInfo
    // version field — the VN only speaks v1 frames, and the meshcore-flutter app
    // aborts the handshake (never sending AppStart) when it sees a version it
    // can't reconcile. Stand up a fresh server whose local node reports fw ver 7.
    const realNode: MeshCoreNode = { ...LOCAL_NODE, firmwareVer: 7, firmwareBuild: '25-Jun-2026', model: 'Heltec V3' };
    const realManager = new FakeManager(realNode);
    const realServer = new MeshCoreVirtualNodeServer({ port: 0, manager: realManager, databaseService: CHANNELS_DB });
    await realServer.start();
    const realClient = new TestClient();
    await realClient.connect(realServer.getListeningPort()!);
    try {
      const payload = await realClient.request([CommandCodes.DeviceQuery, 1]);
      expect(payload[0]).toBe(ResponseCodes.DeviceInfo);
      expect(payload.readInt8(1)).toBe(SUPPORTED_COMPANION_PROTOCOL_VERSION);
      expect(payload.readInt8(1)).not.toBe(7);
    } finally {
      realClient.close();
      await realServer.stop();
    }
  });

  it('replies to GetContacts with ContactsStart(N), Contact frames, then EndOfContacts', async () => {
    client.send([CommandCodes.GetContacts, 0, 0, 0, 0]); // since:u32
    const [start, contact, end] = await client.expectFrames(3);
    expect(start[0]).toBe(ResponseCodes.ContactsStart);
    expect(start.readUInt32LE(1)).toBe(1);
    expect(contact[0]).toBe(ResponseCodes.Contact);
    // public key is the 32 bytes right after the response code
    expect(contact.subarray(1, 33).toString('hex')).toBe('b1'.repeat(32));
    expect(end[0]).toBe(ResponseCodes.EndOfContacts);
  });

  it('replies to GetChannel(0) with ChannelInfo from the channels DB', async () => {
    const payload = await client.request([CommandCodes.GetChannel, 0]);
    expect(payload[0]).toBe(ResponseCodes.ChannelInfo);
    expect(payload[1]).toBe(0); // channel index
  });

  it('replies to GetChannel for an unknown slot with Err(NotFound)', async () => {
    const payload = await client.request([CommandCodes.GetChannel, 7]);
    expect(payload[0]).toBe(ResponseCodes.Err);
    expect(payload[1]).toBe(Constants.ErrorCodes.NotFound);
  });

  it('replies to GetBatteryVoltage with BatteryVoltage', async () => {
    const payload = await client.request([CommandCodes.GetBatteryVoltage]);
    expect(payload[0]).toBe(ResponseCodes.BatteryVoltage);
  });

  it('acknowledges SetFloodScope with Ok (read-only no-op)', async () => {
    const payload = await client.request([0x36 /* SetFloodScope=54 */, 0]);
    expect(payload[0]).toBe(ResponseCodes.Ok);
  });

  it('SyncNextMessage returns NoMoreMessages when the queue is empty', async () => {
    const payload = await client.request([CommandCodes.SyncNextMessage]);
    expect(payload[0]).toBe(ResponseCodes.NoMoreMessages);
  });

  it('pushes MsgWaiting on a live incoming message and delivers it via SyncNextMessage', async () => {
    const push = new Promise<Buffer>((resolve) => (client as any).waiters.push(resolve));
    manager.emitMessage({
      id: 'm1',
      fromPublicKey: 'b1'.repeat(32),
      toPublicKey: undefined,
      text: 'incoming dm',
      timestamp: 1_750_000_000_000,
    });
    const pushFrame = await push;
    expect(pushFrame[0]).toBe(PushCodes.MsgWaiting);

    const recv = await client.request([CommandCodes.SyncNextMessage]);
    expect(recv[0]).toBe(ResponseCodes.ContactMsgRecv);
    expect(recv.subarray(-'incoming dm'.length).toString('utf8')).toBe('incoming dm');
  });

  it('delivers an incoming CHANNEL message as ChannelMsgRecv (marker in fromPublicKey)', async () => {
    const push = new Promise<Buffer>((resolve) => (client as any).waiters.push(resolve));
    // Incoming channel messages carry the channel marker in fromPublicKey, with
    // toPublicKey unset, and the sender name in fromName.
    manager.emitMessage({
      id: 'c1',
      fromPublicKey: 'channel-1',
      fromName: 'Yeraze MC Sandbox',
      text: '🤖 Copy that',
      timestamp: 1_750_000_000_000,
    });
    expect((await push)[0]).toBe(PushCodes.MsgWaiting);

    const recv = await client.request([CommandCodes.SyncNextMessage]);
    expect(recv[0]).toBe(ResponseCodes.ChannelMsgRecv);
    expect(recv.readInt8(1)).toBe(1); // channel index
    // sender name is reconstructed into the channel body the firmware would deliver.
    // ChannelMsgRecv header = code + channelIdx + pathLen + txtType + senderTs(4) = 8 bytes.
    expect(recv.subarray(8).toString('utf8')).toBe('Yeraze MC Sandbox: 🤖 Copy that');
  });

  it('does not echo our own channel transmission heard back (matching local name)', async () => {
    manager.emitMessage({
      id: 'c2',
      fromPublicKey: 'channel-1',
      fromName: LOCAL_NODE.name, // our own node's name → our transmission
      text: 'my own msg',
      timestamp: 1_750_000_000_000,
    });
    const payload = await client.request([CommandCodes.SyncNextMessage]);
    expect(payload[0]).toBe(ResponseCodes.NoMoreMessages);
  });

  it('does not echo a message our own node originated', async () => {
    manager.emitMessage({
      id: 'm2',
      fromPublicKey: LOCAL_NODE.publicKey, // self
      text: 'our own send',
      timestamp: 1_750_000_000_000,
    });
    // No MsgWaiting push should arrive; the queue stays empty.
    const payload = await client.request([CommandCodes.SyncNextMessage]);
    expect(payload[0]).toBe(ResponseCodes.NoMoreMessages);
  });

  it('replies to an unsupported command with Err(UnsupportedCmd)', async () => {
    const payload = await client.request([0x7f]); // not a Phase-0 command
    expect(payload[0]).toBe(ResponseCodes.Err);
    expect(payload[1]).toBe(Constants.ErrorCodes.UnsupportedCmd);
  });

  it('forwards SendChannelTxtMsg to the node and replies Ok (not Sent)', async () => {
    // The app's sendChannelTextMessage awaits Ok(0), not Sent(6).
    // [code=3][txtType=0][channelIdx=1][senderTimestamp:u32=0][text]
    const frame = [CommandCodes.SendChannelTxtMsg, 0, 1, 0, 0, 0, 0, ...Buffer.from('hi chan', 'utf8')];
    const payload = await client.request(frame);
    expect(payload[0]).toBe(ResponseCodes.Ok);
    expect(manager.sendMessageMock).toHaveBeenCalledWith('hi chan', undefined, 1);
  });

  it('forwards SendTxtMsg as a DM after resolving the contact prefix, replies Sent with the real ack CRC (#3869)', async () => {
    manager.sendMessageWithResultMock.mockResolvedValueOnce({ ok: true, expectedAckCrc: 0xdeadbeef, estTimeout: 9000 });
    const prefix = Buffer.from('b1'.repeat(6), 'hex'); // first 6 bytes of the sample contact
    // [code=2][txtType=0][attempt=0][senderTimestamp:u32=0][prefix:6][text]
    const frame = [CommandCodes.SendTxtMsg, 0, 0, 0, 0, 0, 0, ...prefix, ...Buffer.from('hi dm', 'utf8')];
    const payload = await client.request(frame);
    expect(payload[0]).toBe(ResponseCodes.Sent);
    // The Sent response must carry the firmware's real ack CRC so the app can
    // correlate the later SendConfirmed push (not the old hardcoded 0).
    expect(Buffer.from(payload).readUInt32LE(2)).toBe(0xdeadbeef);
    expect(manager.sendMessageWithResultMock).toHaveBeenCalledWith('hi dm', 'b1'.repeat(32), undefined);
  });

  it('replies Err(NotFound) for a DM to an unknown contact prefix', async () => {
    const prefix = Buffer.from('ff'.repeat(6), 'hex'); // no matching contact
    const frame = [CommandCodes.SendTxtMsg, 0, 0, 0, 0, 0, 0, ...prefix, ...Buffer.from('x', 'utf8')];
    const payload = await client.request(frame);
    expect(payload[0]).toBe(ResponseCodes.Err);
    expect(payload[1]).toBe(Constants.ErrorCodes.NotFound);
    expect(manager.sendMessageMock).not.toHaveBeenCalled();
  });

  it('replies Err when the node rejects the channel send', async () => {
    manager.sendMessageMock.mockResolvedValueOnce(false);
    const frame = [CommandCodes.SendChannelTxtMsg, 0, 0, 0, 0, 0, 0, ...Buffer.from('nope', 'utf8')];
    const payload = await client.request(frame);
    expect(payload[0]).toBe(ResponseCodes.Err);
  });

  it('counts connected clients', () => {
    expect(server.getClientCount()).toBe(1);
  });

  it('pushes SendConfirmed(0x82) to the originating client when its DM is acked (#3869)', async () => {
    manager.sendMessageWithResultMock.mockResolvedValueOnce({ ok: true, expectedAckCrc: 0x1234, estTimeout: 9000 });
    const prefix = Buffer.from('b1'.repeat(6), 'hex');
    const frame = [CommandCodes.SendTxtMsg, 0, 0, 0, 0, 0, 0, ...prefix, ...Buffer.from('hi dm', 'utf8')];
    expect((await client.request(frame))[0]).toBe(ResponseCodes.Sent);

    // The mesh acks the DM → the server pushes an unsolicited SendConfirmed.
    const pushP = client.expectFrames(1);
    manager.emitSendConfirmed({ ackCode: 0x1234, roundTripMs: 1500 });
    const [push] = await pushP;
    expect(push[0]).toBe(0x82); // PushCodes.SendConfirmed
    expect(Buffer.from(push).readUInt32LE(1)).toBe(0x1234); // ack CRC matches the Sent response
    expect(Buffer.from(push).readUInt32LE(5)).toBe(1500); // round-trip ms
  });

  it('ignores a send_confirmed whose CRC no connected client is awaiting (#3869)', async () => {
    let pushed = false;
    void client.expectFrames(1).then(() => { pushed = true; });
    manager.emitSendConfirmed({ ackCode: 0x9999, roundTripMs: 10 }); // never sent by this client
    await new Promise((r) => setTimeout(r, 40));
    expect(pushed).toBe(false);
  });

  it('forwards the real hop count (pathLen) on an incoming channel message instead of "direct" (#3871)', () => {
    const frame = (server as unknown as { encodeIncomingMessage(m: MeshCoreMessage): Buffer }).encodeIncomingMessage({
      id: 'm1', fromPublicKey: 'channel-2', fromName: 'Alice', text: 'hi', timestamp: Date.now(), pathLen: 3,
    } as MeshCoreMessage);
    // ChannelMsgRecv frame: [code][channelIdx][pathLen][txtType][ts:4][text]
    expect(frame[0]).toBe(ResponseCodes.ChannelMsgRecv);
    expect(frame[1]).toBe(2); // channelIdx
    expect(frame[2]).toBe(3); // real pathLen (was hardcoded 0xff before #3871)
  });

  it('falls back to 0xff (direct) when an incoming message has no pathLen (#3871)', () => {
    const frame = (server as unknown as { encodeIncomingMessage(m: MeshCoreMessage): Buffer }).encodeIncomingMessage({
      id: 'm2', fromPublicKey: 'channel-0', text: 'x', timestamp: Date.now(),
    } as MeshCoreMessage);
    expect(frame[2]).toBe(0xff);
  });
});

describe('MeshCoreVirtualNodeServer — local node not ready', () => {
  it('replies to AppStart with Err(BadState) when no local node', async () => {
    const server = new MeshCoreVirtualNodeServer({
      port: 0,
      manager: makeManager({ getLocalNode: () => null, isConnected: () => false }),
    });
    await server.start();
    const client = new TestClient();
    await client.connect(server.getListeningPort()!);

    const payload = await client.request([CommandCodes.AppStart, 1, 0, 0, 0, 0, 0, 0]);
    expect(payload[0]).toBe(ResponseCodes.Err);
    expect(payload[1]).toBe(Constants.ErrorCodes.BadState);

    client.close();
    await server.stop();
  });
});

// ─────────────── config-command forwarding (issue #3904) ───────────────
// The VN forwards config-mutating companion commands to the real node via the
// manager's typed setters, gated on allowAdminCommands. Before this, every such
// command fell through to Err(UnsupportedCmd) unconditionally.
const toNums = (b: Buffer): number[] => Array.from(b);

function radioParamsFrame(freqKhz: number, bwHz: number, sf: number, cr: number): number[] {
  const b = Buffer.alloc(11);
  b[0] = CommandCodes.SetRadioParams;
  b.writeUInt32LE(freqKhz, 1);
  b.writeUInt32LE(bwHz, 5);
  b[9] = sf;
  b[10] = cr;
  return toNums(b);
}
function latLonFrame(latDeg: number, lonDeg: number): number[] {
  const b = Buffer.alloc(9);
  b[0] = CommandCodes.SetAdvertLatLon;
  b.writeInt32LE(degreesToFixed(latDeg), 1);
  b.writeInt32LE(degreesToFixed(lonDeg), 5);
  return toNums(b);
}
function setChannelFrame(idx: number, name: string, secret: Buffer): number[] {
  const b = Buffer.alloc(50);
  b[0] = CommandCodes.SetChannel;
  b[1] = idx;
  b.write(name, 2, 31, 'utf8'); // cstring(32), leave final byte null
  secret.copy(b, 34, 0, 16);
  return toNums(b);
}
const nameFrame = (name: string): number[] => [CommandCodes.SetAdvertName, ...Buffer.from(name, 'utf8')];
function otherParamsFrame(manualAdd: number, base: number, loc: number, env: number, advLoc: number): number[] {
  const packed = (base & 0b11) | ((loc & 0b11) << 2) | ((env & 0b11) << 4);
  return [CommandCodes.SetOtherParams, manualAdd, packed, advLoc];
}

describe('MeshCoreVirtualNodeServer — config-command forwarding (#3904)', () => {
  let server: MeshCoreVirtualNodeServer;
  let client: TestClient;
  let manager: FakeManager;

  async function startWith(allowAdminCommands: boolean): Promise<void> {
    manager = new FakeManager();
    server = new MeshCoreVirtualNodeServer({ port: 0, manager, allowAdminCommands, databaseService: CHANNELS_DB });
    await server.start();
    client = new TestClient();
    await client.connect(server.getListeningPort()!);
  }

  afterEach(async () => {
    client?.close();
    await server?.stop();
  });

  it('forwards SetAdvertName to manager.setName and replies Ok', async () => {
    await startWith(true);
    const res = await client.request(nameFrame('Rover'));
    expect(res[0]).toBe(ResponseCodes.Ok);
    expect(manager.setNameMock).toHaveBeenCalledWith('Rover');
  });

  it('forwards SetRadioParams in manager units (MHz / kHz) and replies Ok', async () => {
    await startWith(true);
    const res = await client.request(radioParamsFrame(917375, 250000, 11, 5));
    expect(res[0]).toBe(ResponseCodes.Ok);
    const [freq, bw, sf, cr] = manager.setRadioMock.mock.calls[0];
    expect(freq).toBeCloseTo(917.375, 6);
    expect(bw).toBeCloseTo(250, 6);
    expect(sf).toBe(11);
    expect(cr).toBe(5);
  });

  it('forwards SetTxPower and replies Ok', async () => {
    await startWith(true);
    const res = await client.request([CommandCodes.SetTxPower, 20]);
    expect(res[0]).toBe(ResponseCodes.Ok);
    expect(manager.setTxPowerMock).toHaveBeenCalledWith(20);
  });

  it('forwards SetAdvertLatLon as decimal degrees and replies Ok', async () => {
    await startWith(true);
    const res = await client.request(latLonFrame(29.7604, -95.3698));
    expect(res[0]).toBe(ResponseCodes.Ok);
    const [lat, lon] = manager.setCoordsMock.mock.calls[0];
    expect(lat).toBeCloseTo(29.7604, 5);
    expect(lon).toBeCloseTo(-95.3698, 5);
  });

  it('forwards SetChannel (idx, name, hex secret, no scope) and replies Ok', async () => {
    await startWith(true);
    const secret = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
    const res = await client.request(setChannelFrame(1, 'gauntlet', secret));
    expect(res[0]).toBe(ResponseCodes.Ok);
    expect(manager.setChannelMock).toHaveBeenCalledWith(1, 'gauntlet', '000102030405060708090a0b0c0d0e0f', undefined);
  });

  it('forwards SetOtherParams (unpacked telemetry modes) and replies Ok', async () => {
    await startWith(true);
    const res = await client.request(otherParamsFrame(1, 2, 1, 2, 1));
    expect(res[0]).toBe(ResponseCodes.Ok);
    expect(manager.setOtherParamsMock).toHaveBeenCalledWith({
      manualAddContacts: 1,
      telemetryModeBase: 2,
      telemetryModeLoc: 1,
      telemetryModeEnv: 2,
      advLocPolicy: 1,
    });
  });

  it('blocks config commands with Err(UnsupportedCmd) when allowAdminCommands is off, without touching the node', async () => {
    await startWith(false);
    const res = await client.request(nameFrame('Rover'));
    expect(res[0]).toBe(ResponseCodes.Err);
    expect(res[1]).toBe(ErrorCodes.UnsupportedCmd);
    expect(manager.setNameMock).not.toHaveBeenCalled();
  });

  it('replies Err(BadState) when the node rejects the change (manager returns false)', async () => {
    await startWith(true);
    manager.setTxPowerMock.mockResolvedValueOnce(false);
    const res = await client.request([CommandCodes.SetTxPower, 20]);
    expect(res[0]).toBe(ResponseCodes.Err);
    expect(res[1]).toBe(ErrorCodes.BadState);
  });

  it('replies Err(BadState) when the manager throws', async () => {
    await startWith(true);
    manager.setRadioMock.mockRejectedValueOnce(new Error('invalid radio'));
    const res = await client.request(radioParamsFrame(917375, 250000, 11, 5));
    expect(res[0]).toBe(ResponseCodes.Err);
    expect(res[1]).toBe(ErrorCodes.BadState);
  });

  it('replies Err(IllegalArg) on a malformed config payload, without calling the manager', async () => {
    await startWith(true);
    const res = await client.request([CommandCodes.SetRadioParams, 1, 2]); // too short
    expect(res[0]).toBe(ResponseCodes.Err);
    expect(res[1]).toBe(ErrorCodes.IllegalArg);
    expect(manager.setRadioMock).not.toHaveBeenCalled();
  });
});
