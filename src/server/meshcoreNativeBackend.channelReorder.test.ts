/**
 * Native backend commands for the MeshCore on-device channel reorder (#5379):
 *  - set_channel_verified trusts the read-back, not the tag-less Ok/Err ack.
 *  - get_channel_table maps the library's ChannelInfo records.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { MeshCoreNativeBackend, __setMeshCoreModule } from './meshcoreNativeBackend.js';

const AdvType = { None: 0, Chat: 1, Repeater: 2, Room: 3 };

const hex = (c: string) => c.repeat(32 / c.length);
const bytes = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));

class MockConnection extends EventEmitter {
  slots = new Map<number, { name: string; secret: Uint8Array }>();
  /** Simulate a cannibalised ack: the write lands but the promise rejects. */
  rejectAck = false;
  /** Simulate a firmware that silently ignores the write. */
  dropWrite = false;
  async connect() { /* no-op */ }
  async close() { /* no-op */ }
  async getSelfInfo() {
    return { type: AdvType.Chat, publicKey: Uint8Array.from(Array(32).fill(0)), name: 'TestNode' };
  }
  getContacts = vi.fn().mockResolvedValue([]);
  async setChannel(idx: number, name: string, secret: Uint8Array) {
    if (!this.dropWrite) this.slots.set(idx, { name, secret });
    if (this.rejectAck) throw undefined;
  }
  async getChannel(idx: number) {
    const s = this.slots.get(idx) ?? { name: '', secret: new Uint8Array(16) };
    return { channelIdx: idx, name: s.name, secret: s.secret };
  }
  async getChannels() {
    return [0, 1, 2].map((i) => {
      const s = this.slots.get(i) ?? { name: '', secret: new Uint8Array(16) };
      return { channelIdx: i, name: s.name, secret: s.secret };
    });
  }
}

async function connectedBackend() {
  __setMeshCoreModule({
    NodeJSSerialConnection: MockConnection as any,
    TCPConnection: MockConnection as any,
    Constants: { ResponseCodes: {}, PushCodes: {}, StatsTypes: {}, SelfAdvertTypes: {}, BinaryRequestTypes: {}, AdvType, TxtTypes: {} } as any,
    CayenneLpp: { parse: () => [] } as any,
    Packet: {} as any,
  });
  const backend = new MeshCoreNativeBackend('src-ch-reorder', { connectionType: 'serial', serialPort: '/dev/ttyUSB0' });
  await backend.connect();
  return { backend, conn: (backend as any).connection as MockConnection };
}

describe('MeshCoreNativeBackend — channel reorder commands (#5379)', () => {
  afterEach(() => {
    __setMeshCoreModule(null);
    vi.restoreAllMocks();
  });

  it('set_channel_verified reports verified when the read-back matches', async () => {
    const { backend } = await connectedBackend();
    const res = await backend.sendCommand('set_channel_verified', { idx: 2, name: 'ops', secret_hex: hex('ab') });
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ verified: true, channel_idx: 2, name: 'ops', secret_hex: hex('ab'), ack_error: null });
  });

  it('a lost ack does not fail the write when the slot reads back correctly', async () => {
    const { backend, conn } = await connectedBackend();
    conn.rejectAck = true;
    const res = await backend.sendCommand('set_channel_verified', { idx: 1, name: 'ops', secret_hex: hex('cd') });
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ verified: true, ack_error: 'Err ack' });
  });

  it('reports not verified when the device kept the old contents', async () => {
    const { backend, conn } = await connectedBackend();
    conn.slots.set(1, { name: 'old', secret: bytes(hex('11')) });
    conn.dropWrite = true;
    const res = await backend.sendCommand('set_channel_verified', { idx: 1, name: 'new', secret_hex: hex('22') });
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ verified: false, name: 'old', secret_hex: hex('11') });
  });

  it('rejects a bad secret before touching the device', async () => {
    const { backend, conn } = await connectedBackend();
    const spy = vi.spyOn(conn, 'setChannel');
    const res = await backend.sendCommand('set_channel_verified', { idx: 1, name: 'x', secret_hex: 'abcd' });
    expect(res.success).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('get_channel_table returns every slot in order', async () => {
    const { backend, conn } = await connectedBackend();
    conn.slots.set(1, { name: 'ops', secret: bytes(hex('ab')) });
    const res = await backend.sendCommand('get_channel_table', {});
    expect(res.success).toBe(true);
    expect(res.data).toEqual([
      { channel_idx: 0, name: '', secret_hex: hex('0') },
      { channel_idx: 1, name: 'ops', secret_hex: hex('ab') },
      { channel_idx: 2, name: '', secret_hex: hex('0') },
    ]);
  });
});
