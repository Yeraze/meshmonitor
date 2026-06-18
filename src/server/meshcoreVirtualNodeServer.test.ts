import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { Socket } from 'net';
import { Constants } from '@liamcottle/meshcore.js';
import { MeshCoreVirtualNodeServer, type MeshCoreVirtualNodeManager } from './meshcoreVirtualNodeServer.js';
import {
  CommandCodes,
  ResponseCodes,
  PushCodes,
  FRAME_APP_TO_NODE,
  FRAME_NODE_TO_APP,
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
  isConnected() { return this.localNode !== null; }
  getLocalNode() { return this.localNode; }
  getContacts() { return this.contacts; }
  sendMessage(text: string, toPublicKey?: string, channelIdx?: number) {
    return this.sendMessageMock(text, toPublicKey, channelIdx) as Promise<boolean>;
  }
  emitMessage(msg: MeshCoreMessage) { this.emit('message', msg); }
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

  it('replies to GetDeviceTime with a plausible CurrTime', async () => {
    const before = Math.floor(Date.now() / 1000);
    const payload = await client.request([CommandCodes.GetDeviceTime]);
    expect(payload[0]).toBe(ResponseCodes.CurrTime);
    const epoch = payload.readUInt32LE(1);
    expect(epoch).toBeGreaterThanOrEqual(before);
    expect(epoch).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 1);
  });

  it('replies to DeviceQuery with DeviceInfo', async () => {
    const payload = await client.request([CommandCodes.DeviceQuery, 1]);
    expect(payload[0]).toBe(ResponseCodes.DeviceInfo);
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

  it('forwards SendTxtMsg as a DM after resolving the contact prefix, replies Sent', async () => {
    const prefix = Buffer.from('b1'.repeat(6), 'hex'); // first 6 bytes of the sample contact
    // [code=2][txtType=0][attempt=0][senderTimestamp:u32=0][prefix:6][text]
    const frame = [CommandCodes.SendTxtMsg, 0, 0, 0, 0, 0, 0, ...prefix, ...Buffer.from('hi dm', 'utf8')];
    const payload = await client.request(frame);
    expect(payload[0]).toBe(ResponseCodes.Sent);
    expect(manager.sendMessageMock).toHaveBeenCalledWith('hi dm', 'b1'.repeat(32), undefined);
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
