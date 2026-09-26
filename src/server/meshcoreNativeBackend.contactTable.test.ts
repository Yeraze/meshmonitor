/**
 * #5349 — the companion's own contact table.
 *
 * MeshCore companion firmware resolves CMD_SEND_LOGIN / CMD_SEND_STATUS_REQ /
 * CMD_SEND_TXT_MSG targets against its saved contact table and answers a
 * missing one at once with ERR_CODE_NOT_FOUND — nothing goes on the air. The
 * backend now checks first (MESHCORE_CONTACT_NOT_ON_DEVICE), maps a firmware
 * NOT_FOUND Err to the same error, surfaces the 0x8F CONTACT_DELETED / 0x90
 * CONTACTS_FULL pushes, and can add a contact (add_contact) — refusing type 0
 * and reporting what the firmware evicted.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { MeshCoreNativeBackend, __setMeshCoreModule } from './meshcoreNativeBackend.js';
import {
  MESHCORE_CONTACT_NOT_ON_DEVICE,
  MESHCORE_DEVICE_TABLE_FULL,
} from './meshcoreDeviceContactErrors.js';

const ResponseCodes = {
  Ok: 0, Err: 1, ContactsStart: 2, Contact: 3, EndOfContacts: 4,
  SelfInfo: 5, Sent: 6, ContactMsgRecv: 7, ChannelMsgRecv: 8,
  CurrTime: 9, NoMoreMessages: 10, Stats: 24,
};
const PushCodes = {
  Advert: 0x80, PathUpdated: 0x81, MsgWaiting: 0x83, NewAdvert: 0x8a,
  BinaryResponse: 0x8c, TraceData: 0x89, LoginSuccess: 0x85,
};
const AdvType = { None: 0, Chat: 1, Repeater: 2, Room: 3 };
const TxtTypes = { Plain: 0, CliData: 1, SignedPlain: 2 };

const HELD = '5708aa' + '11'.repeat(29); // in the radio's table
const MISSING = '5708bb' + '22'.repeat(29); // known to MeshMonitor only

const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));

class MockConnection extends EventEmitter {
  table: string[] = [HELD];
  loginCalls: string[] = [];
  statusCalls: string[] = [];
  textCalls: string[] = [];
  addCalls: Array<{ publicKey: string; type: number; flags: number; outPathLen: number; lastAdvert: number }> = [];
  /** What the next addOrUpdateContact does: store it, or fail with an Err code. */
  addBehaviour: { kind: 'store'; evict?: string } | { kind: 'err'; code: number } = { kind: 'store' };
  loginBehaviour: 'hang' | { errCode: number } = 'hang';

  async connect() { /* no-op */ }
  async close() { /* no-op */ }
  async getSelfInfo() {
    return { type: AdvType.Chat, publicKey: Uint8Array.from(Array(32).fill(0)), name: 'TestNode' };
  }
  async getContacts() {
    return this.table.map((hex) => ({ publicKey: bytes(hex), type: AdvType.Repeater, advName: hex.slice(0, 4) }));
  }
  sendToRadioFrame(_frame: Uint8Array) { /* no-op */ }

  login(publicKey: Uint8Array, _password: string) {
    this.loginCalls.push(Buffer.from(publicKey).toString('hex'));
    const behaviour = this.loginBehaviour;
    return new Promise((_resolve, reject) => {
      if (behaviour !== 'hang') {
        // meshcore.js: an Err frame rejects login() with NO argument; the
        // errCode is only visible on the emitted Err event.
        this.emit(ResponseCodes.Err, { errCode: behaviour.errCode });
        reject();
      }
    });
  }
  getStatus(publicKey: Uint8Array) {
    this.statusCalls.push(Buffer.from(publicKey).toString('hex'));
    return new Promise(() => { /* never answers */ });
  }
  async sendTextMessage(publicKey: Uint8Array) {
    this.textCalls.push(Buffer.from(publicKey).toString('hex'));
    return { expectedAckCrc: 1, estTimeout: 1000 };
  }
  async addOrUpdateContact(
    publicKey: Uint8Array, type: number, flags: number, outPathLen: number,
    _outPath: Uint8Array, _name: string, lastAdvert: number,
  ) {
    const hex = Buffer.from(publicKey).toString('hex');
    this.addCalls.push({ publicKey: hex, type, flags, outPathLen, lastAdvert });
    const b = this.addBehaviour;
    if (b.kind === 'err') {
      this.emit(ResponseCodes.Err, { errCode: b.code });
      throw undefined;
    }
    if (b.evict) this.table = this.table.filter((k) => k !== b.evict);
    this.table.push(hex);
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
  const backend = new MeshCoreNativeBackend('src-table', { connectionType: 'serial', serialPort: '/dev/ttyUSB0' });
  await backend.connect();
  const events: Array<{ event_type: string; data: any }> = [];
  backend.on('event', (e: any) => events.push(e));
  return { backend, conn: (backend as any).connection as MockConnection, events };
}

describe('MeshCoreNativeBackend — companion contact table (#5349)', () => {
  beforeEach(() => installMockModule());
  afterEach(() => __setMeshCoreModule(null as any));

  describe('pre-check before commands the firmware resolves from its table', () => {
    it('login to a contact the radio does not hold fails with NOT_ON_DEVICE and never calls login()', async () => {
      const { backend, conn } = await connectedBackend();
      const res = await backend.sendCommand('login', { public_key: MISSING, password: 'pw' });
      expect(res.success).toBe(false);
      expect(res.error).toBe(MESHCORE_CONTACT_NOT_ON_DEVICE);
      expect(conn.loginCalls).toEqual([]);
    });

    it('maps a firmware ERR_CODE_NOT_FOUND during login to NOT_ON_DEVICE', async () => {
      const { backend, conn } = await connectedBackend();
      conn.loginBehaviour = { errCode: 2 };
      const res = await backend.sendCommand('login', { public_key: HELD, password: 'pw' });
      expect(conn.loginCalls).toEqual([HELD]);
      expect(res.success).toBe(false);
      expect(res.error).toBe(MESHCORE_CONTACT_NOT_ON_DEVICE);
    });

    it('does not relabel other firmware errors during login', async () => {
      const { backend, conn } = await connectedBackend();
      conn.loginBehaviour = { errCode: 3 };
      const res = await backend.sendCommand('login', { public_key: HELD, password: 'pw' });
      expect(res.success).toBe(false);
      expect(res.error).not.toBe(MESHCORE_CONTACT_NOT_ON_DEVICE);
    });

    it('get_status to a contact the radio does not hold fails with NOT_ON_DEVICE', async () => {
      const { backend, conn } = await connectedBackend();
      const res = await backend.sendCommand('get_status', { public_key: MISSING });
      expect(res.error).toBe(MESHCORE_CONTACT_NOT_ON_DEVICE);
      expect(conn.statusCalls).toEqual([]);
    });

    it('send_cli to a contact the radio does not hold fails with NOT_ON_DEVICE', async () => {
      const { backend, conn } = await connectedBackend();
      const res = await backend.sendCommand('send_cli', { public_key: MISSING, text: 'ver' });
      expect(res.error).toBe(MESHCORE_CONTACT_NOT_ON_DEVICE);
      expect(conn.textCalls).toEqual([]);
    });

    it('send_cli to a held contact is sent', async () => {
      const { backend, conn } = await connectedBackend();
      const res = await backend.sendCommand('send_cli', { public_key: HELD, text: 'ver' });
      expect(res.success).toBe(true);
      expect(conn.textCalls).toEqual([HELD]);
    });
  });

  describe('has_contact', () => {
    it('reports membership and table size', async () => {
      const { backend } = await connectedBackend();
      expect((await backend.sendCommand('has_contact', { public_key: HELD })).data).toEqual({ on_device: true, count: 1 });
      expect((await backend.sendCommand('has_contact', { public_key: MISSING })).data).toEqual({ on_device: false, count: 1 });
    });
  });

  describe('add_contact', () => {
    it('stores the contact with flood path, lastAdvert 0 and the favourite bit', async () => {
      const { backend, conn } = await connectedBackend();
      const res = await backend.sendCommand('add_contact', {
        public_key: MISSING, adv_type: 2, name: 'Rpt B', favorite: true,
      });
      expect(res.success).toBe(true);
      expect(res.data).toEqual({ added: true, already: false, count: 2, evicted: [] });
      expect(conn.addCalls).toEqual([
        { publicKey: MISSING, type: 2, flags: 0x01, outPathLen: 0xff, lastAdvert: 0 },
      ]);
    });

    it('is a no-op for a contact already on the radio', async () => {
      const { backend, conn } = await connectedBackend();
      const res = await backend.sendCommand('add_contact', { public_key: HELD, adv_type: 2 });
      expect(res.data).toMatchObject({ added: false, already: true });
      expect(conn.addCalls).toEqual([]);
    });

    it('refuses type 0 (firmware transient-slot eviction ignores favourites)', async () => {
      const { backend, conn } = await connectedBackend();
      const res = await backend.sendCommand('add_contact', { public_key: MISSING, adv_type: 0 });
      expect(res.success).toBe(false);
      expect(conn.addCalls).toEqual([]);
    });

    it('reports which contact the firmware evicted to make room', async () => {
      const { backend, conn } = await connectedBackend();
      conn.addBehaviour = { kind: 'store', evict: HELD };
      const res = await backend.sendCommand('add_contact', { public_key: MISSING, adv_type: 1 });
      expect(res.data).toMatchObject({ added: true, evicted: [HELD] });
    });

    it('maps ERR_CODE_TABLE_FULL to MESHCORE_DEVICE_TABLE_FULL', async () => {
      const { backend, conn } = await connectedBackend();
      conn.addBehaviour = { kind: 'err', code: 3 };
      const res = await backend.sendCommand('add_contact', { public_key: MISSING, adv_type: 2 });
      expect(res.success).toBe(false);
      expect(res.error).toBe(MESHCORE_DEVICE_TABLE_FULL);
    });
  });

  describe('raw pushes', () => {
    it('surfaces 0x8F CONTACT_DELETED as contact_deleted', async () => {
      const { conn, events } = await connectedBackend();
      conn.emit('rx', Uint8Array.from([0x8f, ...bytes(HELD)]));
      expect(events).toContainEqual({ type: 'event', event_type: 'contact_deleted', data: { public_key: HELD } });
    });

    it('surfaces 0x90 CONTACTS_FULL as contacts_full', async () => {
      const { conn, events } = await connectedBackend();
      conn.emit('rx', Uint8Array.from([0x90]));
      expect(events.some((e) => e.event_type === 'contacts_full')).toBe(true);
    });
  });
});
