/**
 * Tests for the active node-discovery path in MeshCoreNativeBackend.
 *
 * Covers:
 *   1. `discover_nodes` builds the correct CMD_SEND_CONTROL_DATA (55) frame
 *      with a CTL_TYPE_NODE_DISCOVER_REQ (0x80, prefix_only=false) control
 *      payload: [55, 0x80, filter, tag(4B LE)].
 *   2. The 0x8E (PUSH_CODE_CONTROL_DATA) handler parses NODE_DISCOVER_RESP
 *      frames whose tag matches the pending request, emits `node_discovered`,
 *      and auto-adds the node on the device via addOrUpdateContact.
 *   3. Responses with a non-matching tag are ignored.
 *   4. Prefix-only responses (key < 32 bytes) are not auto-added.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { MeshCoreNativeBackend, __setMeshCoreModule } from './meshcoreNativeBackend.js';

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
  addOrUpdateContact = vi.fn().mockResolvedValue(undefined);
  /** Reply bytes a `request_regions` (CMD 57) frame should produce. */
  regionsResponseData: Uint8Array | null = null;
  async connect() { /* no-op */ }
  async close() { /* no-op */ }
  async getSelfInfo() {
    return { type: AdvType.Chat, publicKey: Uint8Array.from(Array(32).fill(0)), name: 'TestNode' };
  }
  sendToRadioFrame(frame: Uint8Array) {
    this.sentFrames.push(frame);
    if (frame[0] === 57) {
      // CMD_SEND_ANON_REQ (regions): reply with a Sent ack (carrying the tag)
      // then the BinaryResponse push with the canned region bytes.
      const tag = 0x99;
      setImmediate(() => {
        this.emit(ResponseCodes.Sent, { expectedAckCrc: tag, estTimeout: 1000 });
        this.emit(PushCodes.BinaryResponse, { reserved: 0, tag, responseData: this.regionsResponseData ?? new Uint8Array() });
      });
      return;
    }
    // discover_nodes (CMD 55) and others: ack with OK on the next tick.
    setImmediate(() => this.emit(ResponseCodes.Ok));
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

async function connectedBackend(): Promise<{ backend: MeshCoreNativeBackend; conn: MockConnection; events: any[] }> {
  const backend = new MeshCoreNativeBackend('src-discover', {
    connectionType: 'serial',
    serialPort: '/dev/ttyUSB0',
  });
  const events: any[] = [];
  backend.on('event', (e) => events.push(e));
  await backend.connect();
  const conn = (backend as any).connection as MockConnection;
  return { backend, conn, events };
}

/** Build a NODE_DISCOVER_RESP 0x8E push frame. */
function buildDiscoverResp(opts: {
  snrX4: number; rssi: number; pathLen: number;
  nodeType: number; responderSnrX4: number; tag: number; pubkey: Uint8Array;
}): Uint8Array {
  const head = [
    0x8e,
    opts.snrX4 & 0xff,
    opts.rssi & 0xff,
    opts.pathLen & 0xff,
    (0x90 | (opts.nodeType & 0x0f)) & 0xff,
    opts.responderSnrX4 & 0xff,
    opts.tag & 0xff,
    (opts.tag >>> 8) & 0xff,
    (opts.tag >>> 16) & 0xff,
    (opts.tag >>> 24) & 0xff,
  ];
  return Uint8Array.from([...head, ...opts.pubkey]);
}

/** Build an inbound NODE_DISCOVER_REQ 0x8E push frame (what we'd receive). */
function buildDiscoverReq(opts: {
  snrX4: number; filter: number; tag: number; prefixOnly?: boolean;
}): Uint8Array {
  return Uint8Array.from([
    0x8e,
    opts.snrX4 & 0xff,
    0x00, // rssi
    0xff, // path_len
    (0x80 | (opts.prefixOnly ? 1 : 0)) & 0xff, // CTL_TYPE_NODE_DISCOVER_REQ
    opts.filter & 0xff,
    opts.tag & 0xff,
    (opts.tag >>> 8) & 0xff,
    (opts.tag >>> 16) & 0xff,
    (opts.tag >>> 24) & 0xff,
  ]);
}

describe('MeshCoreNativeBackend — node discovery', () => {
  beforeEach(() => installMockModule());
  afterEach(() => __setMeshCoreModule(null));

  it('discover_nodes builds [55, 0x80, filter, tag(LE)] and sets the pending tag', async () => {
    const { backend, conn } = await connectedBackend();
    const res = await backend.sendCommand('discover_nodes', { filter: 0x0c, tag: 0x11223344 });
    expect(res.success).toBe(true);

    const frame = conn.sentFrames.at(-1)!;
    expect(Array.from(frame)).toEqual([
      55,         // CMD_SEND_CONTROL_DATA
      0x80,       // CTL_TYPE_NODE_DISCOVER_REQ, prefix_only=false
      0x0c,       // filter = Repeater|Room
      0x44, 0x33, 0x22, 0x11, // tag, little-endian
    ]);
    expect((backend as any).pendingDiscoverTag).toBe(0x11223344);
  });

  it('emits node_discovered and auto-adds when a matching-tag full-key response arrives', async () => {
    const { backend, conn, events } = await connectedBackend();
    const tag = 0xa1b2c3d4;
    await backend.sendCommand('discover_nodes', { filter: 0x0c, tag });

    const pubkey = Uint8Array.from(Array.from({ length: 32 }, (_, i) => i + 1));
    conn.emit('rx', buildDiscoverResp({
      snrX4: 25, rssi: -42 & 0xff, pathLen: 0xff,
      nodeType: AdvType.Repeater, responderSnrX4: 16, tag, pubkey,
    }));

    const ev = events.find((e) => e.event_type === 'node_discovered');
    expect(ev).toBeDefined();
    expect(ev.data.adv_type).toBe(AdvType.Repeater);
    expect(ev.data.snr).toBe(6.25); // 25 / 4
    expect(ev.data.public_key).toBe(
      Array.from(pubkey).map((b) => b.toString(16).padStart(2, '0')).join(''),
    );

    // Auto-added on the device with the full key, type, empty name, flood path.
    expect(conn.addOrUpdateContact).toHaveBeenCalledTimes(1);
    const [keyArg, typeArg, flagsArg, outPathLenArg] = conn.addOrUpdateContact.mock.calls[0];
    expect(Array.from(keyArg as Uint8Array)).toEqual(Array.from(pubkey));
    expect(typeArg).toBe(AdvType.Repeater);
    expect(flagsArg).toBe(0);
    expect(outPathLenArg).toBe(0xff);
  });

  it('ignores responses whose tag does not match the pending request', async () => {
    const { backend, conn, events } = await connectedBackend();
    await backend.sendCommand('discover_nodes', { filter: 0x02, tag: 0x00000001 });

    conn.emit('rx', buildDiscoverResp({
      snrX4: 10, rssi: -50 & 0xff, pathLen: 0xff,
      nodeType: AdvType.Chat, responderSnrX4: 8, tag: 0x99999999,
      pubkey: Uint8Array.from(Array(32).fill(7)),
    }));

    expect(events.find((e) => e.event_type === 'node_discovered')).toBeUndefined();
    expect(conn.addOrUpdateContact).not.toHaveBeenCalled();
  });

  it('does not auto-add a prefix-only (short key) response', async () => {
    const { backend, conn, events } = await connectedBackend();
    const tag = 0x12345678;
    await backend.sendCommand('discover_nodes', { filter: 0x02, tag });

    // prefix_only response carries only 8 key bytes (< 32) → cannot register.
    conn.emit('rx', buildDiscoverResp({
      snrX4: 12, rssi: -33 & 0xff, pathLen: 0xff,
      nodeType: AdvType.Chat, responderSnrX4: 4, tag,
      pubkey: Uint8Array.from(Array(8).fill(0xaa)),
    }));

    expect(events.find((e) => e.event_type === 'node_discovered')).toBeUndefined();
    expect(conn.addOrUpdateContact).not.toHaveBeenCalled();
  });
});

describe('MeshCoreNativeBackend — discovery responder', () => {
  beforeEach(() => installMockModule());
  afterEach(() => __setMeshCoreModule(null));

  // Our mock self is a Chat (companion) node with an all-zero 32-byte key.
  const selfTypeBit = 1 << AdvType.Chat; // 0x02

  it('does not respond when discoverable is disabled', async () => {
    const { conn } = await connectedBackend();
    conn.emit('rx', buildDiscoverReq({ snrX4: 20, filter: 0x1e, tag: 0x11111111 }));
    expect(conn.sentFrames.some((f) => f[0] === 55)).toBe(false);
  });

  it('responds with NODE_DISCOVER_RESP when enabled and the filter matches our type', async () => {
    const { backend, conn } = await connectedBackend();
    backend.setRespondToDiscovery(true);
    conn.emit('rx', buildDiscoverReq({ snrX4: 24, filter: selfTypeBit, tag: 0xaabbccdd }));

    const resp = conn.sentFrames.find((f) => f[0] === 55);
    expect(resp).toBeDefined();
    expect(resp![1]).toBe(0x90 | AdvType.Chat); // 0x91
    expect(resp![2]).toBe(24); // echoed inbound SNR byte
    // tag echoed (LE)
    expect(Array.from(resp!.slice(3, 7))).toEqual([0xdd, 0xcc, 0xbb, 0xaa]);
    // full 32-byte key (prefix_only=false)
    expect(resp!.length).toBe(7 + 32);
  });

  it('ignores a request whose filter excludes our node type', async () => {
    const { backend, conn } = await connectedBackend();
    backend.setRespondToDiscovery(true);
    // 0x0c = Repeater|Room only — our Chat bit (0x02) is not set
    conn.emit('rx', buildDiscoverReq({ snrX4: 10, filter: 0x0c, tag: 0x22222222 }));
    expect(conn.sentFrames.some((f) => f[0] === 55)).toBe(false);
  });

  it('returns an 8-byte key when the request asks for prefix_only', async () => {
    const { backend, conn } = await connectedBackend();
    backend.setRespondToDiscovery(true);
    conn.emit('rx', buildDiscoverReq({ snrX4: 5, filter: selfTypeBit, tag: 0x33333333, prefixOnly: true }));
    const resp = conn.sentFrames.find((f) => f[0] === 55);
    expect(resp).toBeDefined();
    expect(resp!.length).toBe(7 + 8);
  });

  it('rate-limits to 4 responses per window', async () => {
    const { backend, conn } = await connectedBackend();
    backend.setRespondToDiscovery(true);
    for (let i = 0; i < 6; i++) {
      conn.emit('rx', buildDiscoverReq({ snrX4: 12, filter: selfTypeBit, tag: 0x40000000 + i }));
    }
    expect(conn.sentFrames.filter((f) => f[0] === 55).length).toBe(4);
  });

  it('request_regions sends [57, pubkey, 0x01, 0x00] and parses clock + region names (#3667)', async () => {
    const { backend, conn } = await connectedBackend();
    // clock(4 LE)=1 + "muenchen,bayern,*" + NUL + trailing junk (must be ignored)
    conn.regionsResponseData = Uint8Array.from([
      1, 0, 0, 0,
      ...Buffer.from('muenchen,bayern,*', 'ascii'),
      0,
      ...Buffer.from('JUNK', 'ascii'),
    ]);

    const res = await backend.sendCommand('request_regions', { public_key: 'aa'.repeat(32) });
    expect(res.success).toBe(true);

    // Outbound frame layout: CMD 57 + 32-byte pubkey + req_type 0x01 + reply_path_len 0.
    const frame = conn.sentFrames.at(-1)!;
    expect(frame.length).toBe(1 + 32 + 2);
    expect(frame[0]).toBe(57);
    expect(Array.from(frame.slice(1, 33))).toEqual(Array(32).fill(0xaa));
    expect(frame[33]).toBe(0x01);
    expect(frame[34]).toBe(0x00);

    // Parsed reply: clock from the first 4 bytes, names split on ',' up to the
    // NUL. The wildcard '*' is preserved here (the manager filters it).
    expect(res.data.clock).toBe(1);
    expect(res.data.regions).toEqual(['muenchen', 'bayern', '*']);
  });

  it('request_regions succeeds when Sent ack carries no expectedAckCrc (payload-less Sent path)', async () => {
    // A Sent event emitted with no argument (r=undefined) produces tag=null.
    // The code must still accept the first BinaryResponse after Sent.
    const { backend, conn } = await connectedBackend();

    (conn as any).sendToRadioFrame = (frame: Uint8Array) => {
      conn.sentFrames.push(frame);
      if (frame[0] === 57) {
        setImmediate(() => {
          conn.emit(ResponseCodes.Sent); // no payload → r=undefined
          conn.emit(PushCodes.BinaryResponse, {
            reserved: 0,
            tag: 0xdeadbeef,
            responseData: Uint8Array.from([
              2, 0, 0, 0, // clock = 2
              ...Buffer.from('berlin', 'ascii'),
              0,
            ]),
          });
        });
        return;
      }
      setImmediate(() => conn.emit(ResponseCodes.Ok));
    };

    const res = await backend.sendCommand('request_regions', { public_key: 'bb'.repeat(32) });
    expect(res.success).toBe(true);
    expect(res.data.clock).toBe(2);
    expect(res.data.regions).toEqual(['berlin']);
  });

  it('request_regions resolves when expectedAckCrc from Sent does not match BinaryResponse tag (#3734)', async () => {
    // ANON_REQ (57) via sendToRadioFrame: the Sent ack carries a real
    // expectedAckCrc (CRC of the outgoing packet), but the repeater's
    // BinaryResponse carries tag=0 (ANON_REQ does not echo the CRC unlike
    // SendBinaryReq (50)). The old tag-matching guard rejected every response,
    // causing a 15-second timeout for every discover attempt.
    const { backend, conn } = await connectedBackend();

    (conn as any).sendToRadioFrame = (frame: Uint8Array) => {
      conn.sentFrames.push(frame);
      if (frame[0] === 57) {
        setImmediate(() => {
          // Real firmware sends a non-zero expectedAckCrc (CRC of the ANON_REQ
          // packet it just sent to the repeater).
          conn.emit(ResponseCodes.Sent, { expectedAckCrc: 0xcafe1234, estTimeout: 5000 });
          // The repeater's BinaryResponse carries tag=0 (ANON_REQ tagging is
          // independent of SendBinaryReq tagging).
          conn.emit(PushCodes.BinaryResponse, {
            reserved: 0,
            tag: 0, // does NOT match expectedAckCrc
            responseData: Uint8Array.from([
              5, 0, 0, 0, // clock = 5
              ...Buffer.from('cologne,duesseldorf', 'ascii'),
              0,
            ]),
          });
        });
        return;
      }
      setImmediate(() => conn.emit(ResponseCodes.Ok));
    };

    const res = await backend.sendCommand('request_regions', { public_key: 'cc'.repeat(32) });
    expect(res.success).toBe(true);
    expect(res.data.clock).toBe(5);
    expect(res.data.regions).toEqual(['cologne', 'duesseldorf']);
  });

  it('serializes overlapping 0x8C consumers so a concurrent telemetry reply is not stolen by request_regions (#3667)', async () => {
    // request_regions (raw frame, tag-blind first-match) and request_telemetry
    // (library sendBinaryRequest) both ride PUSH_CODE_BINARY_RESPONSE (0x8C).
    // runExclusiveRadioOp must keep them from overlapping on this connection —
    // otherwise the regions listener consumes the telemetry reply and parses
    // CayenneLPP bytes as a region list.
    const { backend, conn } = await connectedBackend();
    const callLog: string[] = [];

    // Regions: payload-less Sent (sendToRadioFrame path) + a recognizable list.
    (conn as any).sendToRadioFrame = (frame: Uint8Array) => {
      conn.sentFrames.push(frame);
      if (frame[0] === 57) {
        callLog.push('regions:send');
        setImmediate(() => {
          conn.emit(ResponseCodes.Sent);
          callLog.push('regions:reply');
          conn.emit(PushCodes.BinaryResponse, {
            reserved: 0,
            tag: 0xcafef00d,
            responseData: Uint8Array.from([1, 0, 0, 0, ...Buffer.from('saxony', 'ascii'), 0]),
          });
        });
        return;
      }
      setImmediate(() => conn.emit(ResponseCodes.Ok));
    };

    // Telemetry: emit a 0x8C push on the SHARED bus (what a real reply does, and
    // exactly what a concurrent regions listener would wrongly grab) then
    // resolve with the binary payload the library's sendBinaryRequest returns.
    const telemetryBytes = Uint8Array.from([0xff, 0xfe, 0xfd, 0xfc]);
    (conn as any).sendBinaryRequest = (_pubkey: Uint8Array, _req: number[]) =>
      new Promise<Uint8Array>((resolve) => {
        callLog.push('telemetry:send');
        setImmediate(() => {
          conn.emit(PushCodes.BinaryResponse, { reserved: 0, tag: 0x11111111, responseData: telemetryBytes });
          callLog.push('telemetry:reply');
          resolve(telemetryBytes);
        });
      });

    // Fire both concurrently on the same connection.
    const [regionsRes, telemetryRes] = await Promise.all([
      backend.sendCommand('request_regions', { public_key: 'aa'.repeat(32) }),
      backend.sendCommand('request_telemetry', { public_key: 'bb'.repeat(32) }),
    ]);

    // Each op resolved with its OWN payload — no cross-contamination. If the
    // regions listener had stolen the telemetry reply, regions would be [] (the
    // 4 telemetry bytes parse as clock-only with no names).
    expect(regionsRes.success).toBe(true);
    expect(regionsRes.data.regions).toEqual(['saxony']);
    expect(telemetryRes.success).toBe(true);

    // The two ops never overlapped: each ':send' is immediately followed by its
    // own ':reply' before the other op's ':send' (order between them is
    // microtask-dependent, so assert pairing rather than absolute order).
    expect(callLog).toHaveLength(4);
    const op = (s: string) => s.split(':')[0];
    expect(op(callLog[0])).toBe(op(callLog[1]));
    expect(op(callLog[2])).toBe(op(callLog[3]));
    expect(op(callLog[0])).not.toBe(op(callLog[2]));
  });

  it('advances the 0x8C chain when an op times out so the next op still runs (#3667)', async () => {
    // The serializer must release on rejection, not just resolution: if
    // request_regions times out (never receives a BinaryResponse), a queued
    // request_telemetry must still proceed — otherwise a single dead repeater
    // would wedge the connection's 0x8C queue.
    const { backend, conn } = await connectedBackend();
    const callLog: string[] = [];

    // Regions: send the frame but NEVER reply, forcing the inner timeout.
    (conn as any).sendToRadioFrame = (frame: Uint8Array) => {
      conn.sentFrames.push(frame);
      if (frame[0] === 57) {
        callLog.push('regions:send');
        return; // no Sent / no BinaryResponse → request_regions times out
      }
      setImmediate(() => conn.emit(ResponseCodes.Ok));
    };

    const telemetryBytes = Uint8Array.from([0xaa, 0xbb]);
    (conn as any).sendBinaryRequest = (_pubkey: Uint8Array, _req: number[]) =>
      new Promise<Uint8Array>((resolve) => {
        callLog.push('telemetry:send');
        setImmediate(() => {
          callLog.push('telemetry:reply');
          resolve(telemetryBytes);
        });
      });

    // Regions is issued first, so it acquires the lock first (both resume from
    // resolvePublicKey in FIFO microtask order); a short timeout_ms keeps the
    // test fast. Telemetry must wait, then run once regions' timeout rejects.
    const [regionsRes, telemetryRes] = await Promise.all([
      backend.sendCommand('request_regions', { public_key: 'aa'.repeat(32), timeout_ms: 30 }),
      backend.sendCommand('request_telemetry', { public_key: 'bb'.repeat(32) }),
    ]);

    expect(regionsRes.success).toBe(false);
    expect(regionsRes.error).toMatch(/timed out/i);
    expect(telemetryRes.success).toBe(true);

    // Order proves the chain advanced past the rejection: regions sent (and held
    // the lock) first, and telemetry only sent after regions' timeout released it.
    expect(callLog).toEqual(['regions:send', 'telemetry:send', 'telemetry:reply']);
  });

  it('request_regions ignores a foreign Err that arrives after its Sent ack (#3725)', async () => {
    // The Err channel is shared and untagged, and unlocked library commands
    // (e.g. send_message) can emit on it. Once request_regions has its Sent ack,
    // a later Err belongs to a different command and must NOT reject the in-flight
    // BinaryResponse wait. Without the !sentReceived gate this rejects instead.
    const { backend, conn } = await connectedBackend();

    (conn as any).sendToRadioFrame = (frame: Uint8Array) => {
      conn.sentFrames.push(frame);
      if (frame[0] === 57) {
        setImmediate(() => {
          conn.emit(ResponseCodes.Sent);            // our send was accepted
          conn.emit(ResponseCodes.Err);             // a FOREIGN command fails on the shared channel
          conn.emit(PushCodes.BinaryResponse, {     // our real reply still arrives
            reserved: 0,
            tag: 0x1,
            responseData: Uint8Array.from([3, 0, 0, 0, ...Buffer.from('bavaria', 'ascii'), 0]),
          });
        });
        return;
      }
      setImmediate(() => conn.emit(ResponseCodes.Ok));
    };

    const res = await backend.sendCommand('request_regions', { public_key: 'aa'.repeat(32) });
    expect(res.success).toBe(true);
    expect(res.data.clock).toBe(3);
    expect(res.data.regions).toEqual(['bavaria']);
  });

  it('serializes a command-ack op (discover_path) against request_regions under the unified lock (#3725)', async () => {
    // discover_path waits on the shared Sent/Err ack; request_regions holds the
    // lock through its multi-second BinaryResponse wait. The unified lock must
    // keep discover_path from sending (and registering its Sent/Err listeners)
    // until regions completes — otherwise regions' own onSent could grab
    // discover_path's Sent, or vice versa.
    const { backend, conn } = await connectedBackend();
    const callLog: string[] = [];

    (conn as any).sendToRadioFrame = (frame: Uint8Array) => {
      conn.sentFrames.push(frame);
      if (frame[0] === 57) { // request_regions
        callLog.push('regions:send');
        setImmediate(() => {
          conn.emit(ResponseCodes.Sent);
          callLog.push('regions:reply');
          conn.emit(PushCodes.BinaryResponse, {
            reserved: 0,
            tag: 0x1,
            responseData: Uint8Array.from([1, 0, 0, 0, ...Buffer.from('thuringia', 'ascii'), 0]),
          });
        });
        return;
      }
      if (frame[0] === 52) { // discover_path
        callLog.push('discover_path:send');
        setImmediate(() => {
          callLog.push('discover_path:ack');
          conn.emit(ResponseCodes.Sent);
        });
        return;
      }
      setImmediate(() => conn.emit(ResponseCodes.Ok));
    };

    const [regionsRes, pathRes] = await Promise.all([
      backend.sendCommand('request_regions', { public_key: 'aa'.repeat(32) }),
      backend.sendCommand('discover_path', { public_key: 'cc'.repeat(32) }),
    ]);

    expect(regionsRes.success).toBe(true);
    expect(regionsRes.data.regions).toEqual(['thuringia']);
    expect(pathRes.success).toBe(true);

    // regions (issued first) holds the lock through its reply; discover_path only
    // sends afterwards — the two never share the ack channel.
    expect(callLog).toEqual(['regions:send', 'regions:reply', 'discover_path:send', 'discover_path:ack']);
  });

  it('serializes set_device_time against request_regions under the unified lock (#3725)', async () => {
    // set_device_time uses the same shared Ok/Err ack window as discover_*, and
    // sends via c.sendCommandSetDeviceTime rather than sendToRadioFrame. The
    // unified lock must keep it from overlapping request_regions' window.
    const { backend, conn } = await connectedBackend();
    const callLog: string[] = [];

    (conn as any).sendToRadioFrame = (frame: Uint8Array) => {
      conn.sentFrames.push(frame);
      if (frame[0] === 57) { // request_regions
        callLog.push('regions:send');
        setImmediate(() => {
          conn.emit(ResponseCodes.Sent);
          callLog.push('regions:reply');
          conn.emit(PushCodes.BinaryResponse, {
            reserved: 0,
            tag: 0x1,
            responseData: Uint8Array.from([1, 0, 0, 0, ...Buffer.from('hesse', 'ascii'), 0]),
          });
        });
        return;
      }
      setImmediate(() => conn.emit(ResponseCodes.Ok));
    };
    (conn as any).sendCommandSetDeviceTime = (_epoch: number) => {
      callLog.push('settime:send');
      setImmediate(() => {
        callLog.push('settime:ack');
        conn.emit(ResponseCodes.Ok);
      });
      return Promise.resolve();
    };

    const [regionsRes, timeRes] = await Promise.all([
      backend.sendCommand('request_regions', { public_key: 'aa'.repeat(32) }),
      backend.sendCommand('set_device_time', { epoch: 1_700_000_000 }),
    ]);

    expect(regionsRes.success).toBe(true);
    expect(regionsRes.data.regions).toEqual(['hesse']);
    expect(timeRes.success).toBe(true);

    // The two never overlapped: each op's ':send' is immediately followed by its
    // own ':ack'/':reply'. Lock-acquisition order is microtask-dependent here
    // (set_device_time has no await before the lock), so assert pairing rather
    // than absolute order.
    expect(callLog).toHaveLength(4);
    const op = (s: string) => s.split(':')[0];
    expect(op(callLog[0])).toBe(op(callLog[1]));
    expect(op(callLog[2])).toBe(op(callLog[3]));
    expect(op(callLog[0])).not.toBe(op(callLog[2]));
  });
});
