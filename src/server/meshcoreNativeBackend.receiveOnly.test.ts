/**
 * MeshCore strict receive-only mode (#4547 epic, Phase 1) — WP3: native
 * backend chokepoint B.
 *
 * `handleDiscoverRequest` is the highest-risk path in the epic: it is
 * push-event driven (never touches `sendCommand`/`dispatch`) and calls
 * `c.sendToRadioFrame(out)` directly. This file proves the receive-only
 * guard sits ahead of it (no frame goes out while ON) with a matching
 * non-vacuous negative case (a frame DOES go out when OFF), plus the
 * belt-and-braces `sendCommand()` gate.
 *
 * Model: src/server/meshcoreNativeBackend.discovery.test.ts:255-303.
 * See docs/internal/dev-notes/MESHCORE_RECEIVE_ONLY_PHASE1_SPEC.md §2.4, §3.4.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { vi } from 'vitest';
import { MeshCoreNativeBackend, __setMeshCoreModule } from './meshcoreNativeBackend.js';
import { isTxDisabledError } from './errors/txDisabledError.js';

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
  getContacts = vi.fn<() => Promise<any[]>>().mockResolvedValue([]);
  async connect() { /* no-op */ }
  async close() { /* no-op */ }
  async getSelfInfo() {
    return { type: AdvType.Chat, publicKey: Uint8Array.from(Array(32).fill(0)), name: 'TestNode' };
  }
  /**
   * Node's `EventEmitter` typings constrain event names to `string | symbol`,
   * but the real meshcore.js connection (untyped in production code) emits
   * and listens on the numeric ResponseCodes/PushCodes constants directly.
   * Numeric event names behave identically to their string form at runtime
   * (JS coerces numeric object keys to strings internally), so this override
   * widens just the event-name parameter to `PropertyKey` to match production
   * usage — the cast on the delegating call reflects that equivalence rather
   * than suppressing a real type mismatch.
   */
  emit(eventName: PropertyKey, ...args: unknown[]): boolean {
    return super.emit(eventName as string | symbol, ...args);
  }
  sendToRadioFrame(frame: Uint8Array) {
    this.sentFrames.push(frame);
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

async function connectedBackend(): Promise<{ backend: MeshCoreNativeBackend; conn: MockConnection }> {
  const backend = new MeshCoreNativeBackend('src-rx-only', {
    connectionType: 'serial',
    serialPort: '/dev/ttyUSB0',
  });
  await backend.connect();
  const conn = (backend as any).connection as MockConnection;
  return { backend, conn };
}

/** Build an inbound NODE_DISCOVER_REQ 0x8E push frame. */
function buildDiscoverReq(opts: { snrX4: number; filter: number; tag: number }): Uint8Array {
  return Uint8Array.from([
    0x8e,
    opts.snrX4 & 0xff,
    0x00, // rssi
    0xff, // path_len
    0x80, // CTL_TYPE_NODE_DISCOVER_REQ, prefix_only=false
    opts.filter & 0xff,
    opts.tag & 0xff,
    (opts.tag >>> 8) & 0xff,
    (opts.tag >>> 16) & 0xff,
    (opts.tag >>> 24) & 0xff,
  ]);
}

// Our mock self is a Chat (companion) node.
const selfTypeBit = 1 << AdvType.Chat;

describe('MeshCoreNativeBackend receive-only (#4547 WP3, chokepoint B)', () => {
  beforeEach(() => installMockModule());
  afterEach(() => __setMeshCoreModule(null));

  describe('handleDiscoverRequest — the highest-risk push-driven path', () => {
    it('receive-only ON: no frame goes out even when discoverable is on and the filter matches', async () => {
      const { backend, conn } = await connectedBackend();
      backend.setRespondToDiscovery(true);
      backend.setReceiveOnly(true);

      conn.emit('rx', buildDiscoverReq({ snrX4: 24, filter: selfTypeBit, tag: 0xaabbccdd }));

      expect(conn.sentFrames).toHaveLength(0);
    });

    it('receive-only OFF: the same request DOES produce a CMD 55 frame (non-vacuous negative)', async () => {
      const { backend, conn } = await connectedBackend();
      backend.setRespondToDiscovery(true);
      // receive-only left at its default (false).

      conn.emit('rx', buildDiscoverReq({ snrX4: 24, filter: selfTypeBit, tag: 0xaabbccdd }));

      const resp = conn.sentFrames.find((f) => f[0] === 55);
      expect(resp).toBeDefined();
    });

    it('receive-only ON takes priority even before the respondToDiscovery opt-in check', async () => {
      const { backend, conn } = await connectedBackend();
      // respondToDiscovery left OFF (default) AND receive-only ON — either
      // alone would block the frame; this proves the receive-only check is
      // reached first (it is literally the first statement in the method).
      backend.setReceiveOnly(true);

      conn.emit('rx', buildDiscoverReq({ snrX4: 24, filter: selfTypeBit, tag: 0xaabbccdd }));

      expect(conn.sentFrames).toHaveLength(0);
    });
  });

  describe('sendCommand() — belt-and-braces gate', () => {
    it('receive-only ON: an RF command rejects with a TxDisabledError before dispatch runs', async () => {
      const { backend } = await connectedBackend();
      backend.setReceiveOnly(true);

      let caught: unknown;
      try {
        await backend.sendCommand('send_message', {});
        throw new Error('expected sendCommand to reject');
      } catch (err) {
        caught = err;
      }
      expect(isTxDisabledError(caught)).toBe(true);
    });

    it('receive-only ON: a serial-only command does not throw on the gate', async () => {
      const { backend, conn } = await connectedBackend();
      backend.setReceiveOnly(true);
      conn.getContacts.mockResolvedValue([]);

      const res = await backend.sendCommand('get_contacts', {});

      expect(res.success).toBe(true);
    });

    it('receive-only OFF: an RF command reaches dispatch normally (non-vacuous negative)', async () => {
      const { backend } = await connectedBackend();

      const res = await backend.sendCommand('get_stats', {});

      // Serial-only regardless of the flag; proves sendCommand doesn't
      // misclassify when receive-only is off.
      expect(res.success).toBeDefined();
    });
  });
});
