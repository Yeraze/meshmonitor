/**
 * Tests for MeshCoreNativeBackend's `trace_path` dispatch (#4786).
 *
 * The pinned `meshcore.js` fork hardcodes the CMD_SEND_TRACE_PATH flags byte
 * to 0, so a discovered 2-byte-hop path gets sent as two 1-byte hops and the
 * device replies to a nonexistent second hop, timing out. The fork's own
 * TraceData(0x89) push parser has a matching bug: it reads `pathSnrs` as
 * `pathLen` bytes (the raw hash-byte count) instead of the hop count
 * (`pathLen >> path_sz`), which would desync a multi-byte reply even with
 * the outgoing flags fixed.
 *
 * MeshCoreNativeBackend now bypasses both by hand-building the outgoing
 * frame with the correct flags byte and installing a corrected TraceData
 * parser for the duration of the request (same pattern as `request_owner`/
 * `request_regions`'s manual frame handling elsewhere in this file).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { MeshCoreNativeBackend, __setMeshCoreModule } from './meshcoreNativeBackend.js';

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
const StatsTypes = { Core: 0, Radio: 1, Packets: 2 };
const SelfAdvertTypes = { ZeroHop: 0, Flood: 1 };
const BinaryRequestTypes = { GetTelemetryData: 0x03 };
const AdvType = { None: 0, Chat: 1, Repeater: 2, Room: 3 };
const TxtTypes = { Plain: 0, CliData: 1, SignedPlain: 2 };

class MockConnection extends EventEmitter {
  sentFrames: Uint8Array[] = [];
  async connect() { /* no-op */ }
  async close() { /* no-op */ }
  async getSelfInfo() {
    return { type: AdvType.Chat, publicKey: Uint8Array.from(Array(32).fill(0)), name: 'TestNode' };
  }
  sendToRadioFrame(frame: Uint8Array) {
    // Keep the original reference (a Buffer in practice) rather than copying
    // into a plain Uint8Array, so tests can use Buffer helpers like
    // readUInt32LE() on the captured frame.
    this.sentFrames.push(frame);
  }
}

function installMockModule(): void {
  __setMeshCoreModule({
    NodeJSSerialConnection: MockConnection as any,
    TCPConnection: MockConnection as any,
    Constants: {
      ResponseCodes, PushCodes, CommandCodes, StatsTypes, SelfAdvertTypes,
      BinaryRequestTypes, AdvType, TxtTypes,
    } as any,
    CayenneLpp: { parse: () => [] } as any,
    Packet: {} as any,
  });
}

async function connectedBackend(): Promise<{ backend: MeshCoreNativeBackend; conn: MockConnection }> {
  const backend = new MeshCoreNativeBackend('src-trace', {
    connectionType: 'serial',
    serialPort: '/dev/ttyUSB0',
  });
  await backend.connect();
  const conn = (backend as any).connection as MockConnection;
  return { backend, conn };
}

/**
 * Encode a raw wire-format TraceData(0x89) push body the way
 * onTraceDataPush() reads it: [reserved][pathLen][flags][tag:4 LE][auth:4 LE]
 * [pathHashes:pathLen][pathSnrs:hopCount][lastSnr] (the leading push-code
 * byte itself is consumed by the connection's own frame dispatcher before
 * onTraceDataPush() runs, so this builds only the body it reads).
 */
function buildTraceDataBody(opts: {
  pathHashes: number[]; pathSz: number; tag: number; snrs: number[]; lastSnr: number;
}): Uint8Array {
  const tagBytes = [
    opts.tag & 0xff, (opts.tag >>> 8) & 0xff, (opts.tag >>> 16) & 0xff, (opts.tag >>> 24) & 0xff,
  ];
  return Uint8Array.from([
    0, // reserved
    opts.pathHashes.length,
    opts.pathSz,
    ...tagBytes,
    0, 0, 0, 0, // auth
    ...opts.pathHashes,
    ...opts.snrs,
    opts.lastSnr & 0xff,
  ]);
}

/** Minimal BufferReader compatible with what onTraceDataPush() expects. */
function readerFor(body: Uint8Array) {
  let p = 0;
  return {
    readByte: () => body[p++],
    readUInt8: () => body[p++],
    readInt8: () => {
      const b = body[p++];
      return (b << 24) >> 24;
    },
    readUInt32LE: () => {
      const v = body[p] | (body[p + 1] << 8) | (body[p + 2] << 16) | (body[p + 3] << 24);
      p += 4;
      return v >>> 0;
    },
    readBytes: (n: number) => {
      const out = body.slice(p, p + n);
      p += n;
      return out;
    },
  };
}

describe('MeshCoreNativeBackend — trace_path (#4786)', () => {
  beforeEach(() => installMockModule());
  afterEach(() => __setMeshCoreModule(null));

  it('sends flags=0 (path_sz=0) for a 1-byte path, unchanged from before the fix', async () => {
    const { backend, conn } = await connectedBackend();
    const promise = backend.sendCommand('trace_path', {
      path: Uint8Array.from([0x0d]),
      path_hash_bytes: 1,
    });

    // Let the frame land, then reply.
    await new Promise((r) => setImmediate(r));
    const frame = conn.sentFrames.at(-1)!;
    expect(frame[0]).toBe(36); // CMD_SEND_TRACE_PATH
    expect(frame[9]).toBe(0); // flags: path_sz=0 → 1 byte/hop
    expect(Array.from(frame.slice(10))).toEqual([0x0d]);

    const tag = (frame as Buffer).readUInt32LE(1);
    const body = buildTraceDataBody({ pathHashes: [0x0d], pathSz: 0, tag, snrs: [40], lastSnr: 28 });
    (conn as any).onTraceDataPush(readerFor(body));

    const res = await promise;
    expect(res.success).toBe(true);
    expect(res.data.pathSnrs).toEqual([40]);
    expect(res.data.lastSnr).toBe(7); // 28 → int8 28 / 4
  });

  it('sends flags=1 (path_sz=1) for a 2-byte path and correctly parses a 1-hop SNR reply — the reported bug', async () => {
    const { backend, conn } = await connectedBackend();
    // "0d34" as one 2-byte hop.
    const promise = backend.sendCommand('trace_path', {
      path: Uint8Array.from([0x0d, 0x34]),
      path_hash_bytes: 2,
    });

    await new Promise((r) => setImmediate(r));
    const frame = conn.sentFrames.at(-1)!;
    expect(frame[0]).toBe(36);
    expect(frame[9]).toBe(1); // flags: path_sz=1 → 2 bytes/hop (was always 0 before the fix)
    expect(Array.from(frame.slice(10))).toEqual([0x0d, 0x34]);

    const tag = (frame as Buffer).readUInt32LE(1);
    // One 2-byte hop → pathHashes has 2 bytes, but pathSnrs has only 1 entry
    // (one hop). Before the fix, meshcore.js would read 2 bytes for pathSnrs
    // here and consume the lastSnr byte too, corrupting the whole parse.
    const body = buildTraceDataBody({
      pathHashes: [0x0d, 0x34], pathSz: 1, tag, snrs: [44], lastSnr: 232 /* -6dB *4, as unsigned byte */,
    });
    (conn as any).onTraceDataPush(readerFor(body));

    const res = await promise;
    expect(res.success).toBe(true);
    expect(res.data.pathLen).toBe(2);
    // Exactly one hop's SNR, not two mis-split bytes.
    expect(res.data.pathSnrs).toEqual([44]);
    // lastSnr correctly read from its own trailing byte, not stolen by an
    // over-long pathSnrs read.
    expect(res.data.lastSnr).toBe(-6);
  });

  it('ignores a TraceData push whose tag does not match this request', async () => {
    const { backend, conn } = await connectedBackend();
    const promise = backend.sendCommand('trace_path', {
      path: Uint8Array.from([0x0d, 0x34]),
      path_hash_bytes: 2,
    }, 200);

    await new Promise((r) => setImmediate(r));
    const foreignBody = buildTraceDataBody({
      pathHashes: [0xaa, 0xbb], pathSz: 1, tag: 0xdeadbeef, snrs: [10], lastSnr: 4,
    });
    (conn as any).onTraceDataPush(readerFor(foreignBody));

    const res = await promise;
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/timeout/i);
  });

  it('rejects a hop hash width the device trace command cannot encode', async () => {
    const { backend } = await connectedBackend();
    const res = await backend.sendCommand('trace_path', {
      path: Uint8Array.from([0x0d, 0x34, 0x56]),
      path_hash_bytes: 3,
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/unsupported hop hash width/i);
  });

  it('rejects an Err response', async () => {
    const { backend, conn } = await connectedBackend();
    const promise = backend.sendCommand('trace_path', {
      path: Uint8Array.from([0x0d]),
      path_hash_bytes: 1,
    });
    await new Promise((r) => setImmediate(r));
    conn.emit(ResponseCodes.Err);

    const res = await promise;
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/rejected/i);
  });

  it('restores the connection\'s original onTraceDataPush after the request settles', async () => {
    const { backend, conn } = await connectedBackend();
    const sentinel = () => {};
    (conn as any).onTraceDataPush = sentinel;

    const promise = backend.sendCommand('trace_path', {
      path: Uint8Array.from([0x0d]),
      path_hash_bytes: 1,
    });
    await new Promise((r) => setImmediate(r));
    // Mid-flight the handler is swapped out for the corrected parser.
    expect((conn as any).onTraceDataPush).not.toBe(sentinel);

    const frame = conn.sentFrames.at(-1)!;
    const tag = (frame as Buffer).readUInt32LE(1);
    const body = buildTraceDataBody({ pathHashes: [0x0d], pathSz: 0, tag, snrs: [4], lastSnr: 0 });
    (conn as any).onTraceDataPush(readerFor(body));
    await promise;

    expect((conn as any).onTraceDataPush).toBe(sentinel);
  });
});
