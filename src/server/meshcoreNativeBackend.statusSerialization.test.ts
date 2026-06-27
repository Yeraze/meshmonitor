/**
 * Regression tests for #3815 — MeshCoreNativeBackend remote-status serialization.
 *
 * The vendored meshcore.js `getStatus()` registers a `.once` listener on the
 * SHARED, tag-less `StatusResponse` push event. When several `getStatus` calls
 * are in flight on the same connection a single arriving response fires EVERY
 * pending once-listener: the matching one resolves while all the others log
 * `"onStatusResponsePush is not for this status request, ignoring..."`, get
 * consumed by `.once`, and hang until their own timeout. That is the
 * self-amplifying log burst + spurious timeouts in #3815.
 *
 * The backend now serializes + dedupes status requests per connection. These
 * tests assert:
 *   1. Two concurrent get_status for the SAME key issue only ONE underlying
 *      getStatus and both resolve with the same result.
 *   2. Two concurrent get_status for DIFFERENT keys do not overlap — the
 *      second's underlying call starts only after the first settles.
 *   3. A rejection in the first request releases the lock so the next proceeds.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { MeshCoreNativeBackend, __setMeshCoreModule } from './meshcoreNativeBackend.js';

const ResponseCodes = { Ok: 0, Err: 1, SelfInfo: 5, Sent: 6 };
const PushCodes = { Advert: 0x80, PathUpdated: 0x81, MsgWaiting: 0x83, NewAdvert: 0x8a, StatusResponse: 0x84 };

interface Deferred {
  key: Uint8Array;
  resolve: (value: any) => void;
  reject: (err?: any) => void;
}

/** Minimal mock connection whose getStatus returns externally-controllable
 *  deferreds so the test can observe call ordering and settle them by hand. */
class StatusMockConnection extends EventEmitter {
  public getStatusCalls: Uint8Array[] = [];
  public pending: Deferred[] = [];

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
  async getContacts() {
    return [];
  }

  getStatus(key: Uint8Array): Promise<any> {
    this.getStatusCalls.push(key);
    return new Promise((resolve, reject) => {
      this.pending.push({ key, resolve, reject });
    });
  }
}

function installMock(): { current: StatusMockConnection | null } {
  const ref: { current: StatusMockConnection | null } = { current: null };
  class TrackedSerial extends StatusMockConnection {
    constructor(_path: string) {
      super();
      ref.current = this;
    }
  }
  __setMeshCoreModule({
    NodeJSSerialConnection: TrackedSerial as any,
    TCPConnection: TrackedSerial as any,
    Constants: { ResponseCodes, PushCodes } as any,
  });
  return ref;
}

async function makeBackend() {
  const backend = new MeshCoreNativeBackend('src-1', {
    connectionType: 'serial',
    serialPort: '/dev/ttyUSB0',
  });
  await backend.connect();
  return backend;
}

// Two distinct full 64-char keys (no contact lookup needed).
const KEY_A = 'aa'.repeat(32);
const KEY_B = 'bb'.repeat(32);

describe('MeshCoreNativeBackend get_status serialization (#3815)', () => {
  let ref: { current: StatusMockConnection | null };

  beforeEach(() => {
    ref = installMock();
  });

  afterEach(() => {
    __setMeshCoreModule(null);
  });

  it('dedupes two concurrent get_status for the SAME key into one underlying request', async () => {
    const backend = await makeBackend();
    const conn = ref.current!;

    const p1 = backend.sendCommand('get_status', { public_key: KEY_A });
    const p2 = backend.sendCommand('get_status', { public_key: KEY_A });

    // Let the dispatch/dedupe microtasks flush.
    await new Promise((r) => setTimeout(r, 5));

    // Only ONE underlying getStatus should have been issued for the shared key.
    expect(conn.getStatusCalls).toHaveLength(1);
    expect(conn.pending).toHaveLength(1);

    // Settle the single in-flight request — both callers resolve with it.
    conn.pending[0].resolve({ batt_milli_volts: 4200, total_up_time_secs: 1234 });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(r1.data?.bat_mv).toBe(4200);
    expect(r2.data?.bat_mv).toBe(4200);
    expect(r1.data?.up_secs).toBe(1234);
    // Still only one underlying request total.
    expect(conn.getStatusCalls).toHaveLength(1);
  });

  it('serializes get_status for DIFFERENT keys so the second starts only after the first settles', async () => {
    const backend = await makeBackend();
    const conn = ref.current!;

    const p1 = backend.sendCommand('get_status', { public_key: KEY_A });
    const p2 = backend.sendCommand('get_status', { public_key: KEY_B });

    await new Promise((r) => setTimeout(r, 5));

    // The second request must NOT have issued its underlying call yet — it is
    // queued behind the first so only one StatusResponse listener is active.
    expect(conn.getStatusCalls).toHaveLength(1);
    expect(Array.from(conn.getStatusCalls[0])).toEqual(Array.from(Buffer.from(KEY_A, 'hex')));

    // Settle the first; the second's underlying call should now fire.
    conn.pending[0].resolve({ batt_milli_volts: 4000 });
    const r1 = await p1;
    await new Promise((r) => setTimeout(r, 5));

    expect(conn.getStatusCalls).toHaveLength(2);
    expect(Array.from(conn.getStatusCalls[1])).toEqual(Array.from(Buffer.from(KEY_B, 'hex')));

    conn.pending[1].resolve({ batt_milli_volts: 3800 });
    const r2 = await p2;

    expect(r1.success).toBe(true);
    expect(r1.data?.bat_mv).toBe(4000);
    expect(r2.success).toBe(true);
    expect(r2.data?.bat_mv).toBe(3800);
  });

  it('releases the lock when the first request rejects so the next proceeds', async () => {
    const backend = await makeBackend();
    const conn = ref.current!;

    const p1 = backend.sendCommand('get_status', { public_key: KEY_A });
    const p2 = backend.sendCommand('get_status', { public_key: KEY_B });

    await new Promise((r) => setTimeout(r, 5));
    expect(conn.getStatusCalls).toHaveLength(1);

    // First request fails (library rejects with no argument on a firmware Err).
    conn.pending[0].reject(undefined);
    const r1 = await p1;
    expect(r1.success).toBe(false);

    // The queue must not be wedged — the second request now issues its call.
    await new Promise((r) => setTimeout(r, 5));
    expect(conn.getStatusCalls).toHaveLength(2);

    conn.pending[1].resolve({ batt_milli_volts: 3700 });
    const r2 = await p2;
    expect(r2.success).toBe(true);
    expect(r2.data?.bat_mv).toBe(3700);
  });

  it('clears the in-flight entry after settle so a later request for the same key issues a fresh call', async () => {
    const backend = await makeBackend();
    const conn = ref.current!;

    const p1 = backend.sendCommand('get_status', { public_key: KEY_A });
    await new Promise((r) => setTimeout(r, 5));
    conn.pending[0].resolve({ batt_milli_volts: 4100 });
    await p1;

    // A brand-new request for the same key after the first settled is NOT a
    // dedupe hit — it must issue a second underlying getStatus.
    const p2 = backend.sendCommand('get_status', { public_key: KEY_A });
    await new Promise((r) => setTimeout(r, 5));
    expect(conn.getStatusCalls).toHaveLength(2);
    conn.pending[1].resolve({ batt_milli_volts: 4050 });
    const r2 = await p2;
    expect(r2.data?.bat_mv).toBe(4050);
  });
});
