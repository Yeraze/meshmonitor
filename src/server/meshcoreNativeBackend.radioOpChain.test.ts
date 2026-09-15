/**
 * Regression tests for #5243: `runExclusiveRadioOp` used to chain unbounded on
 * `fn` — an op with no timer of its own (nothing settles until a device push
 * arrives that never comes) parked `radioOpChain` for the life of the
 * connection. Every later radio op queued behind it sat in `.then()` and its
 * executor — including the `sendToRadioFrame` call that does the actual
 * write — never ran. sendCommand's outer `withTimeout` only rejects the
 * CALLER; it does not cancel `fn` or advance the chain.
 *
 * Covers:
 *   1. A stuck op is eventually released by runExclusiveRadioOp's own 60s
 *      backstop, so a queued op behind it still runs (not forever-parked).
 *   2. `set_out_path` — the confirmed culprit in #5243 — settles on its own
 *      15s inner timer well before the 60s backstop.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { MeshCoreNativeBackend, __setMeshCoreModule } from './meshcoreNativeBackend.js';
import { logger } from '../utils/logger.js';

const ResponseCodes = {
  Ok: 0, Err: 1, ContactsStart: 2, Contact: 3, EndOfContacts: 4,
  SelfInfo: 5, Sent: 6, ContactMsgRecv: 7, ChannelMsgRecv: 8,
  CurrTime: 9, NoMoreMessages: 10, Stats: 24,
};
const PushCodes = {
  Advert: 0x80, PathUpdated: 0x81, MsgWaiting: 0x83, NewAdvert: 0x8a,
  BinaryResponse: 0x8c, ControlData: 0x8e,
};
const StatsTypes = { Core: 0, Radio: 1, Packets: 2 };
const SelfAdvertTypes = { ZeroHop: 0, Flood: 1 };
const BinaryRequestTypes = { GetTelemetryData: 0x03 };
const AdvType = { None: 0, Chat: 1, Repeater: 2, Room: 3 };
const TxtTypes = { Plain: 0, CliData: 1, SignedPlain: 2 };

class MockConnection extends EventEmitter {
  sentFrames: Uint8Array[] = [];
  /** Toggle to simulate a discover_nodes frame that never gets an Ok/Err ack. */
  ackDiscoverNodes = true;
  getContacts = vi.fn<[], Promise<any[]>>().mockResolvedValue([]);
  addOrUpdateContact = vi.fn().mockResolvedValue(undefined);
  setContactPath = vi.fn().mockResolvedValue(undefined);
  async connect() { /* no-op */ }
  async close() { /* no-op */ }
  async getSelfInfo() {
    return { type: AdvType.Chat, publicKey: Uint8Array.from(Array(32).fill(0)), name: 'TestNode' };
  }
  sendToRadioFrame(frame: Uint8Array) {
    this.sentFrames.push(frame);
    if (frame[0] === 55 && this.ackDiscoverNodes) {
      setImmediate(() => this.emit(ResponseCodes.Ok));
    }
    // ackDiscoverNodes === false: swallow the frame — no Ok/Err ever arrives,
    // reproducing the "one unsettled radio op" scenario from #5243.
  }
}

function installMockModule(): void {
  __setMeshCoreModule({
    NodeJSSerialConnection: MockConnection as any,
    TCPConnection: MockConnection as any,
    Constants: {
      ResponseCodes, PushCodes, StatsTypes, SelfAdvertTypes,
      BinaryRequestTypes, AdvType, TxtTypes,
    } as any,
    CayenneLpp: { parse: () => [] } as any,
    Packet: {} as any,
  });
}

async function connectedBackend(): Promise<{ backend: MeshCoreNativeBackend; conn: MockConnection }> {
  const backend = new MeshCoreNativeBackend('src-radio-op-chain', {
    connectionType: 'serial',
    serialPort: '/dev/ttyUSB0',
  });
  await backend.connect();
  const conn = (backend as any).connection as MockConnection;
  return { backend, conn };
}

describe('MeshCoreNativeBackend — runExclusiveRadioOp chain bound (#5243)', () => {
  afterEach(() => {
    __setMeshCoreModule(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('a radio op that never settles is released by the 60s backstop instead of parking the chain forever', async () => {
    installMockModule();
    const { backend, conn } = await connectedBackend();
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();

    conn.ackDiscoverNodes = false;
    const p1 = backend.sendCommand('discover_nodes', { filter: 0x0c, tag: 1 }, 30_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(conn.sentFrames.length).toBe(1);

    conn.ackDiscoverNodes = true;
    // Long outer timeout: op 2's own caller-side timer must not be what's
    // under test here — only whether the backstop frees the chain so its
    // executor (and the actual serial write) ever runs at all.
    const p2 = backend.sendCommand('discover_nodes', { filter: 0x1e, tag: 2 }, 90_000);

    // sendCommand's outer 30s timeout rejects the CALLER's promise, but must
    // NOT advance radioOpChain — op 2 stays queued, its frame unsent.
    await vi.advanceTimersByTimeAsync(30_000);
    const r1 = await p1;
    expect(r1.success).toBe(false);
    expect(r1.error).toMatch(/Native command timeout: discover_nodes/);
    expect(conn.sentFrames.length).toBe(1);

    // runExclusiveRadioOp's own 60s backstop fires next and releases the
    // chain, so op 2's executor — including the actual serial write — runs.
    // runAllTimersAsync (rather than a bare advance) also flushes the Ok ack
    // that op 2's own sendToRadioFrame schedules once it finally executes.
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.runAllTimersAsync();
    const r2 = await p2;
    expect(r2.success).toBe(true);
    expect(conn.sentFrames.length).toBe(2);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("radio-op 'discover_nodes' did not settle within 60000ms"),
    );
  });

  it('set_out_path settles on its own 15s inner timer, well before the 60s backstop, and still releases the chain', async () => {
    installMockModule();
    const { backend, conn } = await connectedBackend();
    vi.useFakeTimers();

    // Simulate the confirmed #5243 culprit: getContacts() never resolves
    // (a missed device push), so set_out_path's read-modify-write hangs.
    conn.getContacts = vi.fn(() => new Promise<any[]>(() => { /* never settles */ }));

    const p1 = backend.sendCommand('set_out_path', {
      public_key: '00'.repeat(32),
      out_path: [1, 2, 3],
    }, 30_000);
    const p2 = backend.sendCommand('discover_nodes', { filter: 0x0c, tag: 7 }, 30_000);

    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(0);

    const r1 = await p1;
    expect(r1.success).toBe(false);
    expect(r1.error).toMatch(/Native command timeout: set_out_path/);

    const r2 = await p2;
    expect(r2.success).toBe(true);
    // Only discover_nodes' frame was ever written — set_out_path's stuck
    // read never reached a sendToRadioFrame call.
    expect(conn.sentFrames.length).toBe(1);
  });
});
