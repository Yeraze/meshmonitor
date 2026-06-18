import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Socket } from 'net';
import { Constants } from '@liamcottle/meshcore.js';
import { MeshCoreVirtualNodeServer, type MeshCoreVirtualNodeManager } from './meshcoreVirtualNodeServer.js';
import {
  CommandCodes,
  ResponseCodes,
  FRAME_APP_TO_NODE,
  FRAME_NODE_TO_APP,
} from './meshcoreCompanionCodec.js';
import type { MeshCoreNode } from './meshcoreManager.js';

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

function makeManager(overrides: Partial<MeshCoreVirtualNodeManager> = {}): MeshCoreVirtualNodeManager {
  return {
    sourceId: 'src-test',
    isConnected: () => true,
    getLocalNode: () => LOCAL_NODE,
    ...overrides,
  };
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

  beforeEach(async () => {
    server = new MeshCoreVirtualNodeServer({ port: 0, manager: makeManager() });
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

  it('replies to GetContacts with ContactsStart(0) then EndOfContacts', async () => {
    client.send([CommandCodes.GetContacts, 0, 0, 0, 0]); // since:u32
    const [start, end] = await client.expectFrames(2);
    expect(start[0]).toBe(ResponseCodes.ContactsStart);
    expect(start.readUInt32LE(1)).toBe(0);
    expect(end[0]).toBe(ResponseCodes.EndOfContacts);
  });

  it('replies to SyncNextMessage with NoMoreMessages', async () => {
    const payload = await client.request([CommandCodes.SyncNextMessage]);
    expect(payload[0]).toBe(ResponseCodes.NoMoreMessages);
  });

  it('replies to an unsupported command with Err(UnsupportedCmd)', async () => {
    const payload = await client.request([0x7f]); // not a Phase-0 command
    expect(payload[0]).toBe(ResponseCodes.Err);
    expect(payload[1]).toBe(Constants.ErrorCodes.UnsupportedCmd);
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
