/**
 * #5502 — native backend: bulk add_contacts and the auto-add toggle.
 *
 *  - add_contacts reads the table once before and once after, skips keys the
 *    radio already holds, stops at ERR_CODE_TABLE_FULL, and verifies by
 *    read-back.
 *  - set_auto_add_contacts reads a fresh SelfInfo and writes a raw
 *    SetOtherParams(38) frame that flips ONLY bit 0 of manual_add_contacts,
 *    keeping the higher per-type bits, the telemetry modes and the advert
 *    location policy.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { MeshCoreNativeBackend, __setMeshCoreModule } from './meshcoreNativeBackend.js';
import { MESHCORE_ERR_CODE_TABLE_FULL } from './meshcoreDeviceContactErrors.js';

const ResponseCodes = {
  Ok: 0, Err: 1, ContactsStart: 2, Contact: 3, EndOfContacts: 4,
  SelfInfo: 5, Sent: 6, ContactMsgRecv: 7, ChannelMsgRecv: 8,
  CurrTime: 9, NoMoreMessages: 10, Stats: 24,
};
const PushCodes = { Advert: 0x80, PathUpdated: 0x81, MsgWaiting: 0x83, NewAdvert: 0x8a };
const AdvType = { None: 0, Chat: 1, Repeater: 2, Room: 3 };
const TxtTypes = { Plain: 0, CliData: 1, SignedPlain: 2 };

const HELD = 'aa'.repeat(32);
const A = '01'.repeat(32);
const B = '02'.repeat(32);
const C = '03'.repeat(32);
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));

class MockConnection extends EventEmitter {
  table: string[] = [HELD];
  getContactsCalls = 0;
  addCalls: string[] = [];
  /** Refuse with TABLE_FULL once the table reaches this size. */
  capacity = Infinity;
  /** Keys whose add "acks" but is not actually stored. */
  silentlyDrop = new Set<string>();
  frames: number[][] = [];
  frameReply: 'ok' | 'err' = 'ok';
  selfInfo: Record<string, unknown> = {
    type: AdvType.Chat,
    publicKey: Uint8Array.from(Array(32).fill(0)),
    name: 'TestNode',
    manualAddContacts: 0b1010_0001, // manual-only + per-type bits
    telemetryMode: 0b0010_0110, // base=2, loc=1, env=2
    telemetryModeBase: 2,
    telemetryModeLoc: 1,
    telemetryModeEnv: 2,
    advLocPolicy: 1,
  };

  async connect() { /* no-op */ }
  async close() { /* no-op */ }
  async getSelfInfo() {
    return { ...this.selfInfo };
  }
  async getContacts() {
    this.getContactsCalls++;
    return this.table.map((hex) => ({ publicKey: bytes(hex), type: AdvType.Repeater, advName: hex.slice(0, 4) }));
  }
  sendToRadioFrame(frame: Uint8Array) {
    this.frames.push(Array.from(frame));
    setTimeout(() => this.emit(this.frameReply === 'ok' ? ResponseCodes.Ok : ResponseCodes.Err, {}), 1);
  }
  async addOrUpdateContact(publicKey: Uint8Array) {
    const hex = Buffer.from(publicKey).toString('hex');
    this.addCalls.push(hex);
    if (this.table.length >= this.capacity) {
      this.emit(ResponseCodes.Err, { errCode: MESHCORE_ERR_CODE_TABLE_FULL });
      throw undefined;
    }
    if (!this.silentlyDrop.has(hex)) this.table.push(hex);
  }
}

function installMockModule(): void {
  __setMeshCoreModule({
    NodeJSSerialConnection: MockConnection as any,
    TCPConnection: MockConnection as any,
    Constants: { ResponseCodes, PushCodes, AdvType, TxtTypes } as any,
    CayenneLpp: { parse: () => [] } as any,
    Packet: {} as any,
  });
}

async function connectedBackend() {
  const backend = new MeshCoreNativeBackend('src-push', { connectionType: 'serial', serialPort: '/dev/ttyUSB0' });
  await backend.connect();
  const conn = (backend as any).connection as MockConnection;
  conn.getContactsCalls = 0;
  return { backend, conn };
}

const contact = (public_key: string, adv_type = 2) => ({ public_key, adv_type, name: 'x', favorite: false });

describe('MeshCoreNativeBackend — add_contacts (#5502)', () => {
  beforeEach(() => installMockModule());
  afterEach(() => __setMeshCoreModule(null as any));

  it('adds every contact with one table read before and one after', async () => {
    const { backend, conn } = await connectedBackend();
    const res = await backend.sendCommand('add_contacts', { contacts: [contact(A), contact(HELD), contact(B)] });
    expect(res.success).toBe(true);
    expect(res.data?.results).toEqual([
      { public_key: A, status: 'added' },
      { public_key: HELD, status: 'already' },
      { public_key: B, status: 'added' },
    ]);
    expect(conn.addCalls).toEqual([A, B]);
    expect(conn.getContactsCalls).toBe(2);
    expect(res.data?.count).toBe(3);
    expect(res.data?.evicted).toEqual([]);
  });

  it('stops at the first TABLE_FULL and does not try the rest', async () => {
    const { backend, conn } = await connectedBackend();
    conn.capacity = 2;
    const res = await backend.sendCommand('add_contacts', { contacts: [contact(A), contact(B), contact(C)] });
    expect(res.data?.results).toEqual([
      { public_key: A, status: 'added' },
      { public_key: B, status: 'table_full' },
      { public_key: C, status: 'not_attempted' },
    ]);
    expect(conn.addCalls).toEqual([A, B]);
  });

  it('marks a contact the read-back does not show as failed', async () => {
    const { backend, conn } = await connectedBackend();
    conn.silentlyDrop.add(A);
    const res = await backend.sendCommand('add_contacts', { contacts: [contact(A)] });
    expect(res.data?.results).toEqual([{ public_key: A, status: 'failed' }]);
  });

  it('refuses an unknown type before touching the radio', async () => {
    const { backend, conn } = await connectedBackend();
    const res = await backend.sendCommand('add_contacts', { contacts: [contact(A), contact(B, 0)] });
    expect(res.success).toBe(false);
    expect(conn.addCalls).toEqual([]);
  });
});

describe('MeshCoreNativeBackend — set_auto_add_contacts (#5502)', () => {
  beforeEach(() => installMockModule());
  afterEach(() => __setMeshCoreModule(null as any));

  it('turning auto-add ON clears only bit 0 and keeps every other field', async () => {
    const { backend, conn } = await connectedBackend();
    const res = await backend.sendCommand('set_auto_add_contacts', { enabled: true });
    expect(res.success).toBe(true);
    expect(conn.frames).toEqual([[38, 0b1010_0000, 0b0010_0110, 1]]);
    expect(res.data).toEqual({ manual_add_contacts: 0b1010_0000, auto_add: true });
    const self = await backend.sendCommand('get_self_info', {});
    expect(self.data?.manual_add_contacts).toBe(0b1010_0000);
  });

  it('turning auto-add OFF sets only bit 0', async () => {
    const { backend, conn } = await connectedBackend();
    conn.selfInfo.manualAddContacts = 0b0100_0000;
    const res = await backend.sendCommand('set_auto_add_contacts', { enabled: false });
    expect(conn.frames).toEqual([[38, 0b0100_0001, 0b0010_0110, 1]]);
    expect(res.data?.auto_add).toBe(false);
  });

  it('packs the telemetry modes when the raw byte is missing', async () => {
    const { backend, conn } = await connectedBackend();
    delete conn.selfInfo.telemetryMode;
    await backend.sendCommand('set_auto_add_contacts', { enabled: true });
    expect(conn.frames[0][2]).toBe(2 | (1 << 2) | (2 << 4));
  });

  it('fails without writing when SelfInfo has no manual_add_contacts', async () => {
    const { backend, conn } = await connectedBackend();
    delete conn.selfInfo.manualAddContacts;
    const res = await backend.sendCommand('set_auto_add_contacts', { enabled: true });
    expect(res.success).toBe(false);
    expect(conn.frames).toEqual([]);
  });

  it('reports a firmware Err', async () => {
    const { backend, conn } = await connectedBackend();
    conn.frameReply = 'err';
    const res = await backend.sendCommand('set_auto_add_contacts', { enabled: true });
    expect(res.success).toBe(false);
  });
});
