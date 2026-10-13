/**
 * #5777 — native backend: get_autoadd_config / set_autoadd_config
 * (CMD 59 / 58, reply RESP_CODE_AUTOADD_CONFIG 25), raw frames on the 'rx' tap.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { MeshCoreNativeBackend, __setMeshCoreModule } from './meshcoreNativeBackend.js';

const ResponseCodes = { Ok: 0, Err: 1, Sent: 6, SelfInfo: 5 };
const PushCodes = { Advert: 0x80 };

class MockConnection extends EventEmitter {
  config = 0b0000_0011;
  maxHops = 3;
  /** 'ok' = firmware knows 58/59; 'err' = old firmware answers Err; 'silent' = no answer. */
  mode: 'ok' | 'err' | 'silent' = 'ok';
  /** Reject the SET with Err (firmware knows 59 but refuses 58). */
  refuseSet = false;
  frames: number[][] = [];
  async connect() { /* no-op */ }
  async close() { /* no-op */ }
  async getSelfInfo() { return {}; }
  sendToRadioFrame(frame: Uint8Array) {
    const f = Array.from(frame);
    this.frames.push(f);
    setTimeout(() => {
      if (this.mode === 'silent') return;
      if (this.mode === 'err') return void this.emit('rx', Uint8Array.from([ResponseCodes.Err, 1]));
      if (f[0] === 59) return void this.emit('rx', Uint8Array.from([25, this.config, this.maxHops]));
      if (f[0] === 58) {
        if (this.refuseSet) return void this.emit('rx', Uint8Array.from([ResponseCodes.Err, 6]));
        this.config = f[1];
        this.maxHops = Math.min(64, f.length > 2 ? f[2] : this.maxHops);
        return void this.emit('rx', Uint8Array.from([ResponseCodes.Ok]));
      }
    }, 1);
  }
}

async function connected() {
  __setMeshCoreModule({
    NodeJSSerialConnection: MockConnection as any,
    TCPConnection: MockConnection as any,
    Constants: { ResponseCodes, PushCodes, AdvType: {}, TxtTypes: {} } as any,
    CayenneLpp: { parse: () => [] } as any,
    Packet: {} as any,
  });
  const backend = new MeshCoreNativeBackend('src-aa', { connectionType: 'serial', serialPort: '/dev/ttyUSB0' });
  await backend.connect();
  const conn = (backend as any).connection as MockConnection;
  conn.frames = [];
  return { backend, conn };
}

describe('MeshCoreNativeBackend auto-add options (#5777)', () => {
  afterEach(() => __setMeshCoreModule(null as any));
  beforeEach(() => { /* fresh module per test via connected() */ });

  it('GET sends [59] and unpacks the bits both ways', async () => {
    const { backend, conn } = await connected();
    conn.config = 0b0001_1101; // overwrite + repeater + room + sensor
    conn.maxHops = 5;
    const res = await backend.sendCommand('get_autoadd_config', {});
    expect(conn.frames).toEqual([[59]]);
    expect(res.data).toEqual({
      supported: true,
      overwrite_oldest: true,
      types: { chat: false, repeater: true, room: true, sensor: true },
      max_hops: 5,
    });
  });

  it('SET is read-modify-write: untouched bits and hops survive, both bytes are sent', async () => {
    const { backend, conn } = await connected();
    conn.config = 0b0000_0011; // overwrite + chat
    conn.maxHops = 3;
    const res = await backend.sendCommand('set_autoadd_config', { types: { room: true } });
    expect(conn.frames).toEqual([[59], [58, 0b0000_1011, 3], [59]]);
    expect(res.data?.types).toEqual({ chat: true, repeater: false, room: true, sensor: false });
    expect(res.data?.overwrite_oldest).toBe(true);
    expect(res.data?.max_hops).toBe(3);
  });

  it('SET packs each field and returns the device answer, not the request', async () => {
    const { backend, conn } = await connected();
    conn.config = 0;
    conn.maxHops = 0;
    const res = await backend.sendCommand('set_autoadd_config', {
      overwrite_oldest: true,
      types: { chat: true, repeater: true, room: false, sensor: true },
      max_hops: 64,
    });
    expect(conn.frames[1]).toEqual([58, 0x01 | 0x02 | 0x04 | 0x10, 64]);
    expect(res.data).toEqual({
      supported: true,
      overwrite_oldest: true,
      types: { chat: true, repeater: true, room: false, sensor: true },
      max_hops: 64,
    });
  });

  it('SET clears a bit when given false', async () => {
    const { backend, conn } = await connected();
    conn.config = 0b0001_1111;
    await backend.sendCommand('set_autoadd_config', { overwrite_oldest: false, types: { sensor: false } });
    expect(conn.frames[1]).toEqual([58, 0b0000_1110, 3]);
  });

  it('refuses an out-of-range max_hops before writing', async () => {
    const { backend, conn } = await connected();
    const res = await backend.sendCommand('set_autoadd_config', { max_hops: 65 });
    expect(res.success).toBe(false);
    expect(conn.frames.some((f) => f[0] === 58)).toBe(false);
  });

  it('old firmware that answers Err reads as unsupported (no throw) and nothing is written', async () => {
    const { backend, conn } = await connected();
    conn.mode = 'err';
    const got = await backend.sendCommand('get_autoadd_config', {});
    expect(got.success).toBe(true);
    expect(got.data?.supported).toBe(false);
    const set = await backend.sendCommand('set_autoadd_config', { overwrite_oldest: true });
    expect(set.success).toBe(true);
    expect(set.data?.supported).toBe(false);
    expect(conn.frames.some((f) => f[0] === 58)).toBe(false);
  });

  it('old firmware that stays silent reads as unsupported after the short timeout', async () => {
    const { backend, conn } = await connected();
    conn.mode = 'silent';
    const got = await backend.sendCommand('get_autoadd_config', {});
    expect(got.data?.supported).toBe(false);
  }, 15_000);

  it('a refused SET surfaces as an error', async () => {
    const { backend, conn } = await connected();
    conn.refuseSet = true;
    const res = await backend.sendCommand('set_autoadd_config', { overwrite_oldest: true });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/rejected/);
  });

  it('serialises two concurrent SETs: frames never interleave', async () => {
    const { backend, conn } = await connected();
    conn.config = 0;
    await Promise.all([
      backend.sendCommand('set_autoadd_config', { types: { chat: true } }),
      backend.sendCommand('set_autoadd_config', { types: { repeater: true } }),
    ]);
    expect(conn.frames.map((f) => f[0])).toEqual([59, 58, 59, 59, 58, 59]);
    // The second saw the first's result, so nothing was lost.
    expect(conn.config).toBe(0x02 | 0x04);
  });
});
