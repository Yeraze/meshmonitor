/**
 * #5866 — native backend: run_cli (CMD_RUN_CLI_COMMAND 66, reply
 * RESP_CODE_CLI_REPLY 29), raw frames on the 'rx' tap.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { MeshCoreNativeBackend, __setMeshCoreModule } from './meshcoreNativeBackend.js';

const ResponseCodes = { Ok: 0, Err: 1, Sent: 6, SelfInfo: 5 };
const PushCodes = { Advert: 0x80 };

class MockConnection extends EventEmitter {
  /** 'ok' = fw 1.18 answers 29; 'err' = older firmware answers Err; 'silent' = no answer. */
  mode: 'ok' | 'err' | 'silent' = 'ok';
  /** Emit frames as plain number[], as meshcore.js's serial and TCP transports do. */
  plainArray = false;
  reply = '> 915.0,250,11,5';
  frames: number[][] = [];
  async connect() { /* no-op */ }
  async close() { /* no-op */ }
  async getSelfInfo() { return {}; }
  sendToRadioFrame(frame: Uint8Array) {
    this.frames.push(Array.from(frame));
    setTimeout(() => {
      if (this.mode === 'silent') return;
      if (this.mode === 'err') return void this.emit('rx', Uint8Array.from([ResponseCodes.Err, 2]));
      // An unrelated frame first: the exchange must ignore it.
      this.emit('rx', Uint8Array.from([PushCodes.Advert, 1, 2]));
      const body = new TextEncoder().encode(this.reply);
      const out = new Uint8Array(1 + body.length);
      out[0] = 29;
      out.set(body, 1);
      this.emit('rx', this.plainArray ? Array.from(out) : out);
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

describe('MeshCoreNativeBackend run_cli (#5866)', () => {
  afterEach(() => __setMeshCoreModule(null as any));

  it('sends [66, ...utf8] and returns the reply text', async () => {
    const { backend, conn } = await connected();
    const res = await backend.sendCommand('run_cli', { command: 'get radio' });
    expect(conn.frames).toEqual([[66, ...new TextEncoder().encode('get radio')]]);
    expect(res).toMatchObject({ success: true, data: { reply: '> 915.0,250,11,5' } });
  });

  it('reads a reply delivered as a plain array (serial / TCP transport)', async () => {
    const { backend, conn } = await connected();
    conn.plainArray = true;
    const res = await backend.sendCommand('run_cli', { command: 'get radio' });
    expect(res).toMatchObject({ success: true, data: { reply: '> 915.0,250,11,5' } });
  });

  it('reports Err from older firmware as a failure', async () => {
    const { backend, conn } = await connected();
    conn.mode = 'err';
    const res = await backend.sendCommand('run_cli', { command: 'ver' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/rejected/);
  });

  it('times out on silence and frees the radio-op lock', async () => {
    const { backend, conn } = await connected();
    conn.mode = 'silent';
    const res = await backend.sendCommand('run_cli', { command: 'reboot', timeout_ms: 20 });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/timed out/);
    conn.mode = 'ok';
    conn.reply = '> 22';
    const next = await backend.sendCommand('run_cli', { command: 'get tx' });
    expect(next.data).toEqual({ reply: '> 22' });
  });
});
