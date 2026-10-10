/**
 * MeshCoreNativeBackend `trace_path` reply wait (#5588).
 *
 * The wait used to be a flat 45 s. It now follows the firmware's own
 * `suggested_timeout_ms` from the Sent ack (meshcore.js: `estTimeout`, tag in
 * `expectedAckCrc`), through the shared policy in
 * constants/meshcoreFirmwareTimeout.ts. A timeout sends nothing more, and a
 * reply that lands after it is dropped without a throw or a stale listener.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { MeshCoreNativeBackend, __setMeshCoreModule } from './meshcoreNativeBackend.js';
import { MESHCORE_TRACE_BRIDGE_TIMEOUT_MS } from './constants/meshcoreFirmwareTimeout.js';

const ResponseCodes = {
  Ok: 0, Err: 1, ContactsStart: 2, Contact: 3, EndOfContacts: 4,
  SelfInfo: 5, Sent: 6, ContactMsgRecv: 7, ChannelMsgRecv: 8,
  CurrTime: 9, NoMoreMessages: 10, Stats: 24,
};
const PushCodes = {
  Advert: 0x80, PathUpdated: 0x81, MsgWaiting: 0x83, NewAdvert: 0x8a,
  BinaryResponse: 0x8c, TraceData: 0x89,
};
const CommandCodes = { SendTracePath: 36 };
const AdvType = { None: 0, Chat: 1, Repeater: 2, Room: 3 };

class MockConnection extends EventEmitter {
  sentFrames: Uint8Array[] = [];
  async connect() { /* no-op */ }
  async close() { /* no-op */ }
  async getSelfInfo() {
    return { type: AdvType.Chat, publicKey: Uint8Array.from(Array(32).fill(0)), name: 'TestNode' };
  }
  sendToRadioFrame(frame: Uint8Array) {
    this.sentFrames.push(frame);
  }
}

function installMockModule(): void {
  __setMeshCoreModule({
    NodeJSSerialConnection: MockConnection as any,
    TCPConnection: MockConnection as any,
    Constants: {
      ResponseCodes, PushCodes, CommandCodes, AdvType,
      StatsTypes: { Core: 0, Radio: 1, Packets: 2 },
      SelfAdvertTypes: { ZeroHop: 0, Flood: 1 },
      BinaryRequestTypes: { GetTelemetryData: 0x03 },
      TxtTypes: { Plain: 0, CliData: 1, SignedPlain: 2 },
    } as any,
    CayenneLpp: { parse: () => [] } as any,
    Packet: {} as any,
  });
}

/** TraceData(0x89) push body, as onTraceDataPush() reads it. */
function traceBody(opts: { pathHashes: number[]; pathSz: number; tag: number; snrs: number[]; lastSnr: number }): Uint8Array {
  return Uint8Array.from([
    0, opts.pathHashes.length, opts.pathSz,
    opts.tag & 0xff, (opts.tag >>> 8) & 0xff, (opts.tag >>> 16) & 0xff, (opts.tag >>> 24) & 0xff,
    0, 0, 0, 0,
    ...opts.pathHashes, ...opts.snrs, opts.lastSnr & 0xff,
  ]);
}

/**
 * A reader with meshcore.js's BufferReader behaviour: `readInt8` past the end
 * throws (DataView on an empty slice), which is what the library's own
 * TraceData parser hits on a multi-byte reply.
 */
function strictReader(body: Uint8Array) {
  let p = 0;
  const take = (n: number) => {
    const out = body.slice(p, p + n);
    p += n;
    return out;
  };
  return {
    readByte: () => take(1)[0],
    readUInt8: () => new DataView(take(1).buffer).getUint8(0),
    readInt8: () => new DataView(take(1).buffer).getInt8(0),
    readUInt32LE: () => new DataView(take(4).buffer).getUint32(0, true),
    readBytes: (n: number) => take(n),
  };
}

const TRACE = { path: Uint8Array.from([0x0d]), path_hash_bytes: 1 };

describe('MeshCoreNativeBackend — trace_path reply wait (#5588)', () => {
  let backend: MeshCoreNativeBackend;
  let conn: MockConnection;

  beforeEach(async () => {
    installMockModule();
    backend = new MeshCoreNativeBackend('src-trace-timeout', { connectionType: 'serial', serialPort: '/dev/ttyUSB0' });
    await backend.connect();
    conn = (backend as any).connection as MockConnection;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    __setMeshCoreModule(null);
  });

  /** Start a trace and return its promise plus the tag it sent. */
  async function startTrace(params: Record<string, unknown> = TRACE) {
    const promise = backend.sendCommand('trace_path', params, MESHCORE_TRACE_BRIDGE_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(0);
    const frame = conn.sentFrames.at(-1) as Buffer;
    return { promise, tag: frame.readUInt32LE(1) };
  }

  // #5722: one TraceData listener stays for the whole session (passive trace
  // capture). The helper below counts that key under both spellings, so the
  // idle state is 2; a trace_path call must add nothing lasting on top of it.
  const IDLE_LISTENERS = { trace: 2, sent: 0, err: 0 };
  const listenerCounts = () => ({
    trace: conn.listenerCount(String(PushCodes.TraceData)) + conn.listenerCount(PushCodes.TraceData as any),
    sent: conn.listenerCount(ResponseCodes.Sent as any),
    err: conn.listenerCount(ResponseCodes.Err as any),
  });

  it('waits hint × 1.2 + 8 s after the Sent ack, not 45 s', async () => {
    const { promise, tag } = await startTrace();
    conn.emit(ResponseCodes.Sent as any, { result: 0, expectedAckCrc: tag, estTimeout: 2_500 });

    let settled = false;
    void promise.then(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(10_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const res = await promise;

    expect(res.success).toBe(false);
    expect(res.error).toBe('trace_path timed out');
    expect(res.data).toEqual({ timed_out: true, wait_ms: 11_000, suggested_timeout_ms: 2_500 });
  });

  it('counts the wait from the send, not from the Sent ack', async () => {
    const { promise, tag } = await startTrace();
    await vi.advanceTimersByTimeAsync(4_000);
    conn.emit(ResponseCodes.Sent as any, { result: 0, expectedAckCrc: tag, estTimeout: 2_500 });

    let settled = false;
    void promise.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(6_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await promise).data.wait_ms).toBe(11_000);
  });

  it('waits the 30 s default when no Sent ack arrives', async () => {
    const { promise } = await startTrace();
    let settled = false;
    void promise.then(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const res = await promise;
    expect(res.data).toEqual({ timed_out: true, wait_ms: 30_000, suggested_timeout_ms: 0 });
  });

  it('waits the 30 s default when the Sent ack carries a 0 hint', async () => {
    const { promise, tag } = await startTrace();
    conn.emit(ResponseCodes.Sent as any, { result: 0, expectedAckCrc: tag, estTimeout: 0 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await promise).data).toEqual({ timed_out: true, wait_ms: 30_000, suggested_timeout_ms: 0 });
  });

  it('caps a huge hint at 60 s and still settles before the bridge timeout', async () => {
    const { promise, tag } = await startTrace();
    conn.emit(ResponseCodes.Sent as any, { result: 0, expectedAckCrc: tag, estTimeout: 500_000 });
    await vi.advanceTimersByTimeAsync(60_000);
    const res = await promise;
    // The trace's own timer answered, not the outer "Native command timeout".
    expect(res.error).toBe('trace_path timed out');
    expect(res.data.wait_ms).toBe(60_000);
  });

  it("ignores another command's Sent ack (different tag)", async () => {
    const { promise, tag } = await startTrace();
    conn.emit(ResponseCodes.Sent as any, { result: 0, expectedAckCrc: (tag + 1) >>> 0, estTimeout: 1 });
    let settled = false;
    void promise.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await promise).data.wait_ms).toBe(30_000);
  });

  it('lets an explicit timeout_ms win over the firmware hint', async () => {
    const { promise, tag } = await startTrace({ ...TRACE, timeout_ms: 3_000 });
    conn.emit(ResponseCodes.Sent as any, { result: 0, expectedAckCrc: tag, estTimeout: 20_000 });
    await vi.advanceTimersByTimeAsync(3_000);
    const res = await promise;
    expect(res.data).toEqual({ timed_out: true, wait_ms: 3_000, suggested_timeout_ms: 20_000 });
  });

  it('returns a reply that lands inside the wait', async () => {
    const { promise, tag } = await startTrace();
    conn.emit(ResponseCodes.Sent as any, { result: 0, expectedAckCrc: tag, estTimeout: 2_500 });
    await vi.advanceTimersByTimeAsync(5_000);
    (conn as any).onTraceDataPush(strictReader(traceBody({ pathHashes: [0x0d], pathSz: 0, tag, snrs: [40], lastSnr: 28 })));
    const res = await promise;
    expect(res.success).toBe(true);
    expect(res.data.pathSnrs).toEqual([40]);
    expect(listenerCounts()).toEqual(IDLE_LISTENERS);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sends one frame per trace and never resends after a timeout', async () => {
    const { promise, tag } = await startTrace();
    conn.emit(ResponseCodes.Sent as any, { result: 0, expectedAckCrc: tag, estTimeout: 2_500 });
    await vi.advanceTimersByTimeAsync(11_000);
    await promise;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(conn.sentFrames).toHaveLength(1);
  });

  it('drops a late reply cleanly: no listener left, no throw, no second settle', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      // 2-byte hops: the library's own parser throws on this reply.
      const { promise, tag } = await startTrace({ path: Uint8Array.from([0x0d, 0x34]), path_hash_bytes: 2 });
      conn.emit(ResponseCodes.Sent as any, { result: 0, expectedAckCrc: tag, estTimeout: 2_500 });
      await vi.advanceTimersByTimeAsync(11_000);
      const res = await promise;
      expect(res.success).toBe(false);

      expect(listenerCounts()).toEqual(IDLE_LISTENERS);
      expect(vi.getTimerCount()).toBe(0);

      const late = traceBody({ pathHashes: [0x0d, 0x34], pathSz: 1, tag, snrs: [44], lastSnr: 232 });
      expect(() => (conn as any).onTraceDataPush(strictReader(late))).not.toThrow();
      // A late Sent / Err for the dead trace is ignored too.
      conn.emit(ResponseCodes.Sent as any, { result: 0, expectedAckCrc: tag, estTimeout: 9_000 });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(vi.getTimerCount()).toBe(0);
      expect(unhandled).not.toHaveBeenCalled();

      // The next trace is unaffected by the late reply to the old one.
      const next = await startTrace({ path: Uint8Array.from([0x0d, 0x34]), path_hash_bytes: 2 });
      expect(next.tag).not.toBe(tag);
      (conn as any).onTraceDataPush(strictReader(late)); // old tag again: ignored
      (conn as any).onTraceDataPush(strictReader(
        traceBody({ pathHashes: [0x0d, 0x34], pathSz: 1, tag: next.tag, snrs: [12], lastSnr: 8 }),
      ));
      const nextRes = await next.promise;
      expect(nextRes.success).toBe(true);
      expect(nextRes.data.pathSnrs).toEqual([12]);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
