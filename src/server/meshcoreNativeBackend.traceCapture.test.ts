/**
 * MeshCoreNativeBackend persistent TraceData capture (#5722).
 *
 * The firmware pushes TraceData for every completed TRACE the radio hears. The
 * backend now keeps the corrected parser and a listener for the whole session
 * and emits each one as a `trace_data` bridge event, flagged `initiated` when
 * this backend sent the trace. The per-request trace_path call still resolves.
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


describe('MeshCoreNativeBackend — persistent TraceData capture (#5722)', () => {
  let backend: MeshCoreNativeBackend;
  let conn: MockConnection & { onTraceDataPush?: (r: ReturnType<typeof strictReader>) => void };
  let events: Array<{ event_type: string; data: any }>;

  beforeEach(async () => {
    installMockModule();
    backend = new MeshCoreNativeBackend('src-trace-capture', { connectionType: 'serial', serialPort: '/dev/ttyUSB0' });
    events = [];
    backend.on('event', (e: { event_type: string; data: any }) => { if (e.event_type === 'trace_data') events.push(e); });
    await backend.connect();
    conn = (backend as any).connection;
  });

  afterEach(() => {
    vi.useRealTimers();
    __setMeshCoreModule(null);
  });

  it('an overheard 1-byte trace becomes a trace_data event with signed quarter-dB SNRs', () => {
    conn.onTraceDataPush!(strictReader(traceBody({
      pathHashes: [0xb1, 0xc3], pathSz: 0, tag: 0x11223344, snrs: [34, 0xea /* -22 */], lastSnr: 0xf4 /* -12 */,
    })));
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({
      tag: 0x11223344, auth_code: 0, flags: 0, hash_bytes: 1,
      path_hashes_hex: 'b1c3', path_snrs_q: [34, -22], last_snr_q: -12, initiated: false,
    });
  });

  it('parses a 2-byte-hop trace without over-reading (#4786 parser, now permanent)', () => {
    conn.onTraceDataPush!(strictReader(traceBody({
      pathHashes: [0xb1, 0xc2, 0xc3, 0xd4], pathSz: 1, tag: 7, snrs: [8, 16], lastSnr: 4,
    })));
    expect(events[0].data).toMatchObject({
      hash_bytes: 2, path_hashes_hex: 'b1c2c3d4', path_snrs_q: [8, 16], last_snr_q: 4,
    });
  });

  it('a reply to a trace we sent is flagged initiated, and the call still resolves', async () => {
    vi.useFakeTimers();
    const promise = backend.sendCommand('trace_path', { path: Uint8Array.from([0x0d]), path_hash_bytes: 1 }, MESHCORE_TRACE_BRIDGE_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(0);
    const tag = (conn.sentFrames.at(-1) as Buffer).readUInt32LE(1);
    conn.onTraceDataPush!(strictReader(traceBody({ pathHashes: [0x0d], pathSz: 0, tag, snrs: [20], lastSnr: 12 })));
    const res = await promise;
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ pathLen: 1, lastSnr: 3 });
    expect(events).toHaveLength(1);
    expect(events[0].data).toMatchObject({ tag, initiated: true, path_snrs_q: [20], last_snr_q: 12 });
  });

  it('keeps capturing after a trace_path call has finished', async () => {
    vi.useFakeTimers();
    const promise = backend.sendCommand('trace_path', { path: Uint8Array.from([0x0d]), path_hash_bytes: 1 }, MESHCORE_TRACE_BRIDGE_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(0);
    const tag = (conn.sentFrames.at(-1) as Buffer).readUInt32LE(1);
    conn.onTraceDataPush!(strictReader(traceBody({ pathHashes: [0x0d], pathSz: 0, tag, snrs: [20], lastSnr: 12 })));
    await promise;
    conn.onTraceDataPush!(strictReader(traceBody({ pathHashes: [0xb1, 0xc2], pathSz: 1, tag: 99, snrs: [1], lastSnr: 2 })));
    expect(events).toHaveLength(2);
    expect(events[1].data).toMatchObject({ tag: 99, initiated: false, hash_bytes: 2 });
  });

  it('sends nothing on its own', () => {
    conn.onTraceDataPush!(strictReader(traceBody({ pathHashes: [0xb1], pathSz: 0, tag: 5, snrs: [1], lastSnr: 2 })));
    expect(conn.sentFrames).toHaveLength(0);
  });
});
