/**
 * #5867 — native backend: Companion-to-Companion remote CLI (fw 1.18.0).
 *  - set_contact_remote_cli flips ContactInfo.flags 0x10 and reads it back.
 *  - send_cli with txt_type 'command' sends TXT_TYPE_CLI_COMMAND (3).
 *  - an inbound CLI command the firmware refused to run is dropped, never
 *    turned into a DM.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { MeshCoreNativeBackend, __setMeshCoreModule } from './meshcoreNativeBackend.js';

const ResponseCodes = { Ok: 0, Err: 1, SelfInfo: 5, Sent: 6, ContactMsgRecv: 7, ChannelMsgRecv: 8 };
const PushCodes = { Advert: 0x80 };
const TxtTypes = { Plain: 0, CliData: 1, SignedPlain: 2 };

const KEY = 'ab'.repeat(32);
const keyBytes = () => Uint8Array.from(Buffer.from(KEY, 'hex'));

class MockConnection extends EventEmitter {
  flags = 0b0000_0011; // favourite + telemetry base
  /** Firmware that ignores the write (read-back shows no change). */
  ignoreWrites = false;
  writes: number[] = [];
  sent: Array<{ text: string; type: number }> = [];
  async connect() { /* no-op */ }
  async close() { /* no-op */ }
  async getSelfInfo() { return {}; }
  async getContacts() {
    return [{
      publicKey: keyBytes(), type: 1, flags: this.flags, outPathLen: -1, outPath: new Uint8Array(64),
      advName: 'Peer', lastAdvert: 0, advLat: 0, advLon: 0, lastMod: 0,
    }];
  }
  async addOrUpdateContact(_pk: Uint8Array, _type: number, flags: number) {
    this.writes.push(flags);
    if (!this.ignoreWrites) this.flags = flags;
  }
  async sendTextMessage(_pk: Uint8Array, text: string, type: number) {
    this.sent.push({ text, type });
    return {};
  }
}

async function connected() {
  __setMeshCoreModule({
    NodeJSSerialConnection: MockConnection as any,
    TCPConnection: MockConnection as any,
    Constants: { ResponseCodes, PushCodes, AdvType: {}, TxtTypes } as any,
    CayenneLpp: { parse: () => [] } as any,
    Packet: {} as any,
  });
  const backend = new MeshCoreNativeBackend('src-aa', { connectionType: 'serial', serialPort: '/dev/ttyUSB0' });
  await backend.connect();
  const conn = (backend as any).connection as MockConnection;
  return { backend, conn };
}

describe('MeshCoreNativeBackend remote CLI (#5867)', () => {
  afterEach(() => __setMeshCoreModule(null as any));

  it('sets bit 0x10 and keeps the other flag bits', async () => {
    const { backend, conn } = await connected();
    const res = await backend.sendCommand('set_contact_remote_cli', { public_key: KEY, allowed: true });
    expect(conn.writes).toEqual([0b0001_0011]);
    expect(res).toMatchObject({ success: true, data: { allowed: true, flags: 0b0001_0011 } });
  });

  it('clears bit 0x10 and keeps the other flag bits', async () => {
    const { backend, conn } = await connected();
    conn.flags = 0b0001_0001;
    const res = await backend.sendCommand('set_contact_remote_cli', { public_key: KEY, allowed: false });
    expect(conn.writes).toEqual([0b0000_0001]);
    expect(res.data).toMatchObject({ allowed: false, flags: 0b0000_0001 });
  });

  it('fails when the read-back shows the old value', async () => {
    const { backend, conn } = await connected();
    conn.ignoreWrites = true;
    const res = await backend.sendCommand('set_contact_remote_cli', { public_key: KEY, allowed: true });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not confirmed/);
  });

  it('sends TXT_TYPE_CLI_COMMAND (3) to a companion, CliData (1) otherwise', async () => {
    const { backend, conn } = await connected();
    await backend.sendCommand('send_cli', { public_key: KEY, text: 'get name', txt_type: 'command' });
    await backend.sendCommand('send_cli', { public_key: KEY, text: 'ver' });
    expect(conn.sent).toEqual([{ text: 'get name', type: 3 }, { text: 'ver', type: 1 }]);
  });

  it('drops an inbound CLI command instead of storing it as a DM', async () => {
    const { backend, conn } = await connected();
    const events: any[] = [];
    backend.on('event', (e) => events.push(e));
    const msg = { pubKeyPrefix: keyBytes().subarray(0, 6), pathLen: 0, senderTimestamp: 1700000000 };
    conn.emit(ResponseCodes.ContactMsgRecv, { ...msg, text: 'reboot', txtType: 3 });
    conn.emit(ResponseCodes.ContactMsgRecv, { ...msg, text: 'hello', txtType: TxtTypes.Plain });
    const kinds = events.map((e) => [e.event_type, e.data?.text]);
    expect(kinds).toEqual([['contact_message', 'hello']]);
  });
});
