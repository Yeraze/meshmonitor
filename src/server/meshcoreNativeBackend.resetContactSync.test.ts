/**
 * #6579 — `reset_contact_sync`: remove the room contact, then write it back
 * with every field it had, so the companion starts it at sync_since = 0
 * (CMD_ADD_UPDATE_CONTACT keeps sync_since on an existing contact and zeroes
 * it only for a new one). Both writes resolve on meshcore.js's uncorrelated
 * ack, so each step is confirmed by reading the table back.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { MeshCoreNativeBackend, __setMeshCoreModule } from './meshcoreNativeBackend.js';
import { MESHCORE_CONTACT_NOT_ON_DEVICE } from './meshcoreDeviceContactErrors.js';

const ResponseCodes = { Ok: 0, Err: 1 };
const PushCodes = { Advert: 0x80, PathUpdated: 0x81, MsgWaiting: 0x83, NewAdvert: 0x8a };
const AdvType = { None: 0, Chat: 1, Repeater: 2, Room: 3 };
const TxtTypes = { Plain: 0, CliData: 1, SignedPlain: 2 };

const ROOM = '5708cc' + '33'.repeat(29);
const OTHER = '5708dd' + '44'.repeat(29);
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));
const hexOf = (b: Uint8Array) => Buffer.from(b).toString('hex');

interface Row {
  publicKey: Uint8Array; type: number; flags: number; outPathLen: number; outPath: Uint8Array;
  advName: string; lastAdvert: number; advLat: number; advLon: number;
}

function roomRow(): Row {
  const outPath = new Uint8Array(64);
  outPath.set([0xa3, 0x7f]);
  return {
    publicKey: bytes(ROOM), type: AdvType.Room, flags: 0x03, outPathLen: 2, outPath,
    advName: 'Room One', lastAdvert: 1_763_000_000, advLat: 51_500_000, advLon: -120_000,
  };
}

class MockConnection extends EventEmitter {
  rows: Row[] = [roomRow(), { ...roomRow(), publicKey: bytes(OTHER), advName: 'Other' }];
  log: string[] = [];
  addArgs: unknown[][] = [];
  removeBehaviour: 'remove' | 'ignore' | 'throw-but-remove' = 'remove';
  addBehaviour: 'store' | 'ignore' | 'throw-but-store' = 'store';

  async connect() { /* no-op */ }
  async close() { /* no-op */ }
  async getSelfInfo() {
    return { type: AdvType.Chat, publicKey: Uint8Array.from(Array(32).fill(0)), name: 'TestNode' };
  }
  async getContacts() {
    this.log.push('get');
    return this.rows.map((r) => ({ ...r }));
  }
  sendToRadioFrame(_frame: Uint8Array) { /* no-op */ }
  async removeContact(pk: Uint8Array) {
    this.log.push(`remove:${hexOf(pk).slice(0, 6)}`);
    if (this.removeBehaviour === 'ignore') return;
    this.rows = this.rows.filter((r) => hexOf(r.publicKey) !== hexOf(pk));
    if (this.removeBehaviour === 'throw-but-remove') throw undefined;
  }
  async addOrUpdateContact(...args: unknown[]) {
    const pk = args[0] as Uint8Array;
    this.log.push(`add:${hexOf(pk).slice(0, 6)}`);
    this.addArgs.push(args);
    if (this.addBehaviour === 'ignore') return;
    const [publicKey, type, flags, outPathLen, outPath, advName, lastAdvert, advLat, advLon] = args as [
      Uint8Array, number, number, number, Uint8Array, string, number, number, number];
    this.rows.push({ publicKey, type, flags, outPathLen, outPath, advName, lastAdvert, advLat, advLon });
    if (this.addBehaviour === 'throw-but-store') throw undefined;
  }
}

function installMockModule(): void {
  __setMeshCoreModule({
    NodeJSSerialConnection: MockConnection as any,
    TCPConnection: MockConnection as any,
    Constants: { ResponseCodes, PushCodes, AdvType, TxtTypes } as any,
    Packet: {} as any,
  });
}

async function connectedBackend() {
  const backend = new MeshCoreNativeBackend('src-reset', { connectionType: 'serial', serialPort: '/dev/ttyUSB0' });
  await backend.connect();
  return { backend, conn: (backend as any).connection as MockConnection };
}

describe('MeshCoreNativeBackend — reset_contact_sync (#6579)', () => {
  beforeEach(() => installMockModule());
  afterEach(() => __setMeshCoreModule(null as any));

  it('removes the contact BEFORE re-adding it, and writes every field back unchanged', async () => {
    const { backend, conn } = await connectedBackend();
    conn.log = [];
    const res = await backend.sendCommand('reset_contact_sync', { public_key: ROOM });
    expect(res.success).toBe(true);
    expect(res.data).toEqual({ removed: true, readded: true });

    const writes = conn.log.filter((l) => !l.startsWith('get'));
    expect(writes).toEqual(['remove:5708cc', 'add:5708cc']);

    const original = roomRow();
    const [pk, type, flags, outPathLen, outPath, name, lastAdvert, lat, lon] = conn.addArgs[0] as [
      Uint8Array, number, number, number, Uint8Array, string, number, number, number];
    expect(hexOf(pk)).toBe(ROOM);
    expect(type).toBe(AdvType.Room);
    expect(flags).toBe(0x03);
    expect(outPathLen).toBe(2);
    expect(Array.from(outPath.subarray(0, 2))).toEqual([0xa3, 0x7f]);
    expect(name).toBe('Room One');
    expect(lastAdvert).toBe(original.lastAdvert);
    expect(lat).toBe(original.advLat);
    expect(lon).toBe(original.advLon);
    // The other contact is untouched.
    expect(conn.rows.some((r) => hexOf(r.publicKey) === OTHER)).toBe(true);
  });

  it('writes a flood path (Int8 -1) back as the 0xff wire byte', async () => {
    const { backend, conn } = await connectedBackend();
    conn.rows[0].outPathLen = -1;
    await backend.sendCommand('reset_contact_sync', { public_key: ROOM });
    expect((conn.addArgs[0] as unknown[])[3]).toBe(0xff);
  });

  it('trusts the read-back over a lost or foreign ack', async () => {
    const { backend, conn } = await connectedBackend();
    conn.removeBehaviour = 'throw-but-remove';
    conn.addBehaviour = 'throw-but-store';
    const res = await backend.sendCommand('reset_contact_sync', { public_key: ROOM });
    expect(res.data).toEqual({ removed: true, readded: true });
  });

  it('does not re-add when the radio did not remove the contact', async () => {
    const { backend, conn } = await connectedBackend();
    conn.removeBehaviour = 'ignore';
    const res = await backend.sendCommand('reset_contact_sync', { public_key: ROOM });
    expect(res.data).toEqual({ removed: false, readded: false });
    expect(conn.addArgs).toHaveLength(0);
  });

  it('reports a re-add the radio did not store', async () => {
    const { backend, conn } = await connectedBackend();
    conn.addBehaviour = 'ignore';
    const res = await backend.sendCommand('reset_contact_sync', { public_key: ROOM });
    expect(res.data).toEqual({ removed: true, readded: false });
  });

  it('fails with NOT_ON_DEVICE for a contact the radio does not hold, and writes nothing', async () => {
    const { backend, conn } = await connectedBackend();
    conn.rows = conn.rows.filter((r) => hexOf(r.publicKey) !== ROOM);
    const res = await backend.sendCommand('reset_contact_sync', { public_key: ROOM });
    expect(res.success).toBe(false);
    expect(res.error).toBe(MESHCORE_CONTACT_NOT_ON_DEVICE);
    expect(conn.log.some((l) => l.startsWith('remove') || l.startsWith('add'))).toBe(false);
  });
});
