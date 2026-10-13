/**
 * Regression test for #5773 — SetOtherParams writers run one at a time.
 *
 * CMD_SET_OTHER_PARAMS carries the three telemetry modes, the advert location
 * policy and the manual-add flag in one frame, so every setter is a
 * read-modify-write against SelfInfo. Three telemetry setters fired together
 * all read the same old snapshot; the last frame to land undid the other two.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { MeshCoreNativeBackend, __setMeshCoreModule } from './meshcoreNativeBackend.js';

const ResponseCodes = { Ok: 0, Err: 1, SelfInfo: 5, Sent: 6 };
const PushCodes = { Advert: 0x80, PathUpdated: 0x81, MsgWaiting: 0x83, NewAdvert: 0x8a, StatusResponse: 0x84 };

/** A device that behaves like the firmware: each setter reads, waits, then writes all fields back. */
class OtherParamsMockConnection extends EventEmitter {
  public device = { telemetryModeBase: 0, telemetryModeLoc: 0, telemetryModeEnv: 0, advLocPolicy: 0 };
  public active = 0;
  public maxActive = 0;

  public selfInfoToEmit: any = {
    type: 1,
    txPower: 22,
    maxTxPower: 22,
    publicKey: Uint8Array.from(new Array(32).fill(0)),
    advLat: 0,
    advLon: 0,
    manualAddContacts: 0,
    radioFreq: 915525,
    radioBw: 62500,
    radioSf: 11,
    radioCr: 5,
    name: 'TestNode',
  };

  async connect() {
    setTimeout(() => this.emit(ResponseCodes.SelfInfo, this.selfInfoToEmit), 1);
  }
  async close() {}
  async getSelfInfo() {
    return this.selfInfoToEmit;
  }

  private async patch(change: Partial<OtherParamsMockConnection['device']>) {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    const snapshot = { ...this.device };
    await new Promise((r) => setTimeout(r, 5));
    this.device = { ...snapshot, ...change };
    this.active -= 1;
  }
  setTelemetryModeBase(mode: number) { return this.patch({ telemetryModeBase: mode }); }
  setTelemetryModeLoc(mode: number) { return this.patch({ telemetryModeLoc: mode }); }
  setTelemetryModeEnv(mode: number) { return this.patch({ telemetryModeEnv: mode }); }
  setAdvertLocPolicy(policy: number) { return this.patch({ advLocPolicy: policy }); }
}

function installMock(): { current: OtherParamsMockConnection | null } {
  const ref: { current: OtherParamsMockConnection | null } = { current: null };
  class Tracked extends OtherParamsMockConnection {
    constructor(_path: string) {
      super();
      ref.current = this;
    }
  }
  __setMeshCoreModule({
    NodeJSSerialConnection: Tracked as any,
    TCPConnection: Tracked as any,
    Constants: { ResponseCodes, PushCodes } as any,
  });
  return ref;
}

async function makeBackend() {
  const backend = new MeshCoreNativeBackend('src-1', { connectionType: 'serial', serialPort: '/dev/ttyUSB0' });
  await backend.connect();
  return backend;
}

describe('MeshCoreNativeBackend SetOtherParams serialization (#5773)', () => {
  let ref: { current: OtherParamsMockConnection | null };

  beforeEach(() => {
    ref = installMock();
  });
  afterEach(() => {
    __setMeshCoreModule(null);
  });

  it('keeps all three telemetry modes when they are saved at once', async () => {
    const backend = await makeBackend();
    const conn = ref.current!;

    const results = await Promise.all([
      backend.sendCommand('set_telemetry_mode_base', { mode: 'always' }),
      backend.sendCommand('set_telemetry_mode_loc', { mode: 'always' }),
      backend.sendCommand('set_telemetry_mode_env', { mode: 'always' }),
    ]);

    expect(results.every((r) => r.success)).toBe(true);
    expect(conn.maxActive).toBe(1);
    expect(conn.device.telemetryModeBase).toBe(conn.device.telemetryModeEnv);
    expect(conn.device.telemetryModeLoc).toBe(conn.device.telemetryModeEnv);
    expect(conn.device.telemetryModeEnv).not.toBe(0);
  });

  it('also holds a telemetry write and the advert location policy apart', async () => {
    const backend = await makeBackend();
    const conn = ref.current!;

    await Promise.all([
      backend.sendCommand('set_telemetry_mode_base', { mode: 'always' }),
      backend.sendCommand('set_advert_loc_policy', { policy: 1 }),
    ]);

    expect(conn.maxActive).toBe(1);
    expect(conn.device.telemetryModeBase).not.toBe(0);
    expect(conn.device.advLocPolicy).toBe(1);
  });

  it('a failed write does not block the next one', async () => {
    const backend = await makeBackend();
    const conn = ref.current!;
    const original = conn.setTelemetryModeBase.bind(conn);
    conn.setTelemetryModeBase = () => Promise.reject(new Error('radio said no'));

    const [first, second] = await Promise.all([
      backend.sendCommand('set_telemetry_mode_base', { mode: 'always' }),
      backend.sendCommand('set_telemetry_mode_loc', { mode: 'always' }),
    ]);
    conn.setTelemetryModeBase = original;

    expect(first.success).toBe(false);
    expect(second.success).toBe(true);
    expect(conn.device.telemetryModeLoc).not.toBe(0);
  });
});
