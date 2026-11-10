/**
 * #6282 - native backend: send_raw_packet (CMD 65), get_default_flood_scope
 * (CMD 64 -> RESP 28), and the DeviceInfo tail bytes from device_query.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { MeshCoreNativeBackend, __setMeshCoreModule } from './meshcoreNativeBackend.js';
import { isTxDisabledError } from './errors/txDisabledError.js';

const ResponseCodes = { Ok: 0, Err: 1, Sent: 6, SelfInfo: 5 };

class MockConnection extends EventEmitter {
  static fwVer = 14;
  /** What the radio answers to a frame: 'ok' | err code | 'silent' | frames to emit. */
  answer: 'ok' | 'silent' | { err: number } | { frames: number[][] } = 'ok';
  frames: number[][] = [];
  deviceInfoFrame: number[] | null = null;
  async connect() { /* no-op */ }
  async close() { /* no-op */ }
  async getSelfInfo() { return {}; }
  async deviceQuery() {
    if (this.deviceInfoFrame) this.emit('rx', Uint8Array.from(this.deviceInfoFrame));
    return { firmwareVer: MockConnection.fwVer, manufacturerModel: 'Model\0v1.0', reserved: [] };
  }
  sendToRadioFrame(frame: Uint8Array) {
    this.frames.push(Array.from(frame));
    setTimeout(() => {
      const a = this.answer;
      if (a === 'silent') return;
      if (a === 'ok') return void this.emit('rx', Uint8Array.from([ResponseCodes.Ok]));
      if ('err' in a) return void this.emit('rx', Uint8Array.from([ResponseCodes.Err, a.err]));
      for (const f of a.frames) this.emit('rx', Array.from(f));
    }, 1);
  }
}

async function connected(fwVer = 14) {
  MockConnection.fwVer = fwVer;
  __setMeshCoreModule({
    NodeJSSerialConnection: MockConnection as any,
    TCPConnection: MockConnection as any,
    Constants: { ResponseCodes, PushCodes: {}, AdvType: {}, TxtTypes: {} } as any,
    CayenneLpp: { parse: () => [] } as any,
    Packet: {} as any,
  });
  const backend = new MeshCoreNativeBackend('src-raw', { connectionType: 'serial', serialPort: '/dev/ttyUSB0' });
  await backend.connect();
  const conn = (backend as any).connection as MockConnection;
  conn.frames = [];
  return { backend, conn };
}

const FRAME_HEX = '4101150011223344';

describe('send_raw_packet (#6282)', () => {
  afterEach(() => __setMeshCoreModule(null as any));

  it('writes the frame bytes unchanged and resolves on Ok', async () => {
    const { backend, conn } = await connected();
    const res = await backend.sendCommand('send_raw_packet', { frame_hex: FRAME_HEX });
    expect(res).toMatchObject({ success: true, data: { sent: true } });
    expect(conn.frames).toEqual([[0x41, 0x01, 0x15, 0x00, 0x11, 0x22, 0x33, 0x44]]);
  });

  it.each([
    [1, 'FIRMWARE_UNSUPPORTED'],
    [3, 'TABLE_FULL'],
    [6, 'ILLEGAL_ARG'],
    [9, 'RAW_SEND_FAILED'],
  ])('maps Err %i to %s', async (code, name) => {
    const { backend, conn } = await connected();
    conn.answer = { err: code };
    const res = await backend.sendCommand('send_raw_packet', { frame_hex: FRAME_HEX });
    expect(res.success).toBe(false);
    expect(res.data).toEqual({ error_code: name });
  });

  it('refuses before any write when firmware is older than v13', async () => {
    const { backend, conn } = await connected(12);
    const res = await backend.sendCommand('send_raw_packet', { frame_hex: FRAME_HEX });
    expect(res.success).toBe(false);
    expect(res.data).toEqual({ error_code: 'FIRMWARE_UNSUPPORTED' });
    expect(conn.frames).toEqual([]);
  });

  it('refuses a malformed or oversized frame before any write', async () => {
    const { backend, conn } = await connected();
    for (const hex of ['zz', '4201150011', '41' + '00'.repeat(176)]) {
      const res = await backend.sendCommand('send_raw_packet', { frame_hex: hex });
      expect(res.data).toEqual({ error_code: 'FRAME_INVALID' });
    }
    expect(conn.frames).toEqual([]);
  });

  it('is blocked in receive-only mode, with nothing written', async () => {
    const { backend, conn } = await connected();
    backend.setReceiveOnly(true);
    await expect(backend.sendCommand('send_raw_packet', { frame_hex: FRAME_HEX })).rejects.toSatisfy(isTxDisabledError);
    expect(conn.frames).toEqual([]);
  });
});

describe('get_default_flood_scope (#6282)', () => {
  afterEach(() => __setMeshCoreModule(null as any));

  it('parses a default scope reply', async () => {
    const { backend, conn } = await connected();
    const name = [...Buffer.from('region')];
    const reply = [28, ...name, ...Array(31 - name.length).fill(0), ...Array.from({ length: 16 }, (_, i) => i + 1)];
    conn.answer = { frames: [reply] };
    const res = await backend.sendCommand('get_default_flood_scope', {});
    expect(conn.frames).toEqual([[64]]);
    expect(res.data).toEqual({ default: { name: 'region', key_hex: '0102030405060708090a0b0c0d0e0f10' } });
  });

  it('returns null when the node has no default (bare RESP 28)', async () => {
    const { backend, conn } = await connected();
    conn.answer = { frames: [[28]] };
    const res = await backend.sendCommand('get_default_flood_scope', {});
    expect(res.data).toEqual({ default: null });
  });

  it('is allowed in receive-only mode (local read)', async () => {
    const { backend, conn } = await connected();
    backend.setReceiveOnly(true);
    conn.answer = { frames: [[28]] };
    const res = await backend.sendCommand('get_default_flood_scope', {});
    expect(res.success).toBe(true);
  });
});

describe('device_query tail bytes (#6282)', () => {
  afterEach(() => __setMeshCoreModule(null as any));

  it('returns repeat and path_hash_mode from the raw DeviceInfo frame', async () => {
    const { backend, conn } = await connected(14);
    conn.deviceInfoFrame = [13, 14, ...Array(78).fill(0), 1, 2];
    const res = await backend.sendCommand('device_query', {});
    expect(res.data).toMatchObject({ repeat: true, path_hash_mode: 2 });
  });

  it('leaves them undefined on a short frame or old firmware', async () => {
    const { backend, conn } = await connected(8);
    conn.deviceInfoFrame = [13, 8, ...Array(78).fill(0), 1, 2];
    const res = await backend.sendCommand('device_query', {});
    expect(res.data.repeat).toBeUndefined();
    expect(res.data.path_hash_mode).toBeUndefined();
  });
});
