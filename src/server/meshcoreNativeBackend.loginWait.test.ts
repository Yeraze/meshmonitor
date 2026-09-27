/**
 * #5400: MeshCoreNativeBackend runs the login exchange itself.
 *
 * meshcore.js `login()` gives up at the firmware's Sent estTimeout + 1 s, so
 * a reply from a node several hops out routinely missed it and every retry
 * repeated the miss. The backend now waits max(estTimeout × 2, 10 s), can be
 * cancelled through an AbortSignal, and detaches every listener and timer on
 * every exit path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import {
  MeshCoreNativeBackend,
  MESHCORE_LOGIN_REJECTED,
  __setMeshCoreModule,
} from './meshcoreNativeBackend.js';
import {
  MESHCORE_LOGIN_CANCELLED,
  MESHCORE_LOGIN_REPLY_WAIT_CEILING_MS,
  MESHCORE_LOGIN_REPLY_WAIT_FLOOR_MS,
  MESHCORE_LOGIN_SENT_ACK_TIMEOUT_MS,
  meshcoreLoginReplyWaitMs,
} from './constants/meshcoreLogin.js';

const ResponseCodes = {
  Ok: 0, Err: 1, ContactsStart: 2, Contact: 3, EndOfContacts: 4,
  SelfInfo: 5, Sent: 6, ContactMsgRecv: 7, ChannelMsgRecv: 8,
  CurrTime: 9, NoMoreMessages: 10, Stats: 24,
};
const PushCodes = {
  Advert: 0x80, PathUpdated: 0x81, MsgWaiting: 0x83, NewAdvert: 0x8a,
  BinaryResponse: 0x8c, TraceData: 0x89, LoginSuccess: 0x85,
};
const AdvType = { None: 0, Chat: 1, Repeater: 2, Room: 3 };
const TxtTypes = { Plain: 0, CliData: 1, SignedPlain: 2 };

const KEY_HEX = 'c1c2c3c4c5c6' + 'dd'.repeat(26);
const prefix = () => Uint8Array.from(Buffer.from(KEY_HEX.substring(0, 12), 'hex'));

class MockConnection extends EventEmitter {
  sends = 0;
  /** estTimeout the radio reports in its Sent ack; null = never ack. */
  estTimeout: number | null = 4000;

  async connect() { /* no-op */ }
  async close() { /* no-op */ }
  async getSelfInfo() {
    return { type: AdvType.Chat, publicKey: Uint8Array.from(Array(32).fill(0)), name: 'TestNode' };
  }
  async getContacts() {
    return [{ publicKey: Uint8Array.from(Buffer.from(KEY_HEX, 'hex')), advType: AdvType.Repeater }];
  }
  sendToRadioFrame(_frame: Uint8Array) { /* no-op */ }

  async sendCommandSendLogin() {
    this.sends++;
    if (this.estTimeout !== null) {
      this.emit(ResponseCodes.Sent, { result: 0, expectedAckCrc: 0, estTimeout: this.estTimeout });
    }
  }

  succeed() {
    this.emit(PushCodes.LoginSuccess, { pubKeyPrefix: prefix(), isAdmin: 1, firmwareVerLevel: 7 });
  }

  /** Listener count across every event the login exchange touches. */
  loginListenerCount() {
    return this.listenerCount(ResponseCodes.Sent)
      + this.listenerCount(ResponseCodes.Err)
      + this.listenerCount(PushCodes.LoginSuccess)
      + this.listenerCount('rx');
  }
}

async function connectedBackend() {
  __setMeshCoreModule({
    NodeJSSerialConnection: MockConnection as any,
    TCPConnection: MockConnection as any,
    Constants: { ResponseCodes, PushCodes, AdvType, TxtTypes } as any,
    CayenneLpp: { parse: () => [] } as any,
    Packet: {} as any,
  });
  const backend = new MeshCoreNativeBackend('src-wait', { connectionType: 'serial', serialPort: '/dev/ttyUSB0' });
  await backend.connect();
  const conn = (backend as any).connection as MockConnection;
  return { backend, conn, baseline: conn.loginListenerCount() };
}

/** Let the dispatch reach sendCommandSendLogin (contact lookup is async). */
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('meshcoreLoginReplyWaitMs (#5400)', () => {
  it('doubles the firmware estimate', () => {
    expect(meshcoreLoginReplyWaitMs(8000)).toBe(16_000);
  });
  it('never waits less than the 10 s floor', () => {
    expect(meshcoreLoginReplyWaitMs(1200)).toBe(MESHCORE_LOGIN_REPLY_WAIT_FLOOR_MS);
    expect(meshcoreLoginReplyWaitMs(0)).toBe(MESHCORE_LOGIN_REPLY_WAIT_FLOOR_MS);
    expect(meshcoreLoginReplyWaitMs(undefined)).toBe(MESHCORE_LOGIN_REPLY_WAIT_FLOOR_MS);
    expect(meshcoreLoginReplyWaitMs(Number.NaN)).toBe(MESHCORE_LOGIN_REPLY_WAIT_FLOOR_MS);
  });
  it('caps a garbage estimate at the ceiling', () => {
    expect(meshcoreLoginReplyWaitMs(10_000_000)).toBe(MESHCORE_LOGIN_REPLY_WAIT_CEILING_MS);
  });
});

describe('MeshCoreNativeBackend login exchange (#5400)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    __setMeshCoreModule(null as any);
  });

  it('waits max(estTimeout x 2, 10 s): a reply at 15 s of a 16 s window still logs in', async () => {
    const { backend, conn, baseline } = await connectedBackend();
    conn.estTimeout = 8000; // meshcore.js would have given up at 9 s
    const onWait = vi.fn();
    const pending = backend.sendCommand('login', { public_key: KEY_HEX, password: 'pw', onWait }, 120_000);
    await flush();
    expect(onWait).toHaveBeenCalledWith(16_000);

    await vi.advanceTimersByTimeAsync(15_000);
    conn.succeed();
    const res = await pending;
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ ok: true, is_admin: 1, firmware_ver_level: 7 });
    expect(conn.loginListenerCount()).toBe(baseline);
  });

  it('uses the 10 s floor for a short estimate, then times out and cleans up', async () => {
    const { backend, conn, baseline } = await connectedBackend();
    conn.estTimeout = 1500;
    const onWait = vi.fn();
    const pending = backend.sendCommand('login', { public_key: KEY_HEX, password: 'pw', onWait }, 120_000);
    await flush();
    expect(onWait).toHaveBeenCalledWith(10_000);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(conn.loginListenerCount()).toBeGreaterThan(baseline); // still listening
    await vi.advanceTimersByTimeAsync(1);
    const res = await pending;
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/no reply/i);
    expect(conn.loginListenerCount()).toBe(baseline);
    expect(vi.getTimerCount()).toBe(0);

    // A reply after the deadline is not heard (nothing left listening).
    conn.succeed();
    expect(conn.loginListenerCount()).toBe(baseline);
  });

  it('gives up when the radio never acks the send', async () => {
    const { backend, conn, baseline } = await connectedBackend();
    conn.estTimeout = null;
    const pending = backend.sendCommand('login', { public_key: KEY_HEX, password: 'pw' }, 120_000);
    await flush();
    await vi.advanceTimersByTimeAsync(MESHCORE_LOGIN_SENT_ACK_TIMEOUT_MS);
    const res = await pending;
    expect(res.success).toBe(false);
    expect(conn.loginListenerCount()).toBe(baseline);
  });

  it('cancels mid-wait, detaches everything, and ignores a late reply', async () => {
    const { backend, conn, baseline } = await connectedBackend();
    const controller = new AbortController();
    const pending = backend.sendCommand('login', { public_key: KEY_HEX, password: 'pw', signal: controller.signal }, 120_000);
    await flush();
    await vi.advanceTimersByTimeAsync(3000);
    controller.abort();
    const res = await pending;
    expect(res.success).toBe(false);
    expect(res.error).toBe(MESHCORE_LOGIN_CANCELLED);
    expect(conn.loginListenerCount()).toBe(baseline);
    expect(vi.getTimerCount()).toBe(0);
    conn.succeed(); // late reply: nobody is listening
    expect(conn.loginListenerCount()).toBe(baseline);
  });

  it('never sends when already cancelled', async () => {
    const { backend, conn, baseline } = await connectedBackend();
    const controller = new AbortController();
    controller.abort();
    const res = await backend.sendCommand('login', { public_key: KEY_HEX, password: 'pw', signal: controller.signal }, 120_000);
    expect(res.error).toBe(MESHCORE_LOGIN_CANCELLED);
    expect(conn.sends).toBe(0);
    expect(conn.loginListenerCount()).toBe(baseline);
  });

  it('a LoginFail during the long wait still rejects at once and cleans up', async () => {
    const { backend, conn, baseline } = await connectedBackend();
    const pending = backend.sendCommand('login', { public_key: KEY_HEX, password: 'bad' }, 120_000);
    await flush();
    conn.emit('rx', Uint8Array.from([0x86, 0, ...prefix()]));
    const res = await pending;
    expect(res.error).toBe(MESHCORE_LOGIN_REJECTED);
    expect(conn.loginListenerCount()).toBe(baseline);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores a LoginSuccess for a different node', async () => {
    const { backend, conn } = await connectedBackend();
    const pending = backend.sendCommand('login', { public_key: KEY_HEX, password: 'pw' }, 120_000);
    await flush();
    conn.emit(PushCodes.LoginSuccess, { pubKeyPrefix: Uint8Array.from([1, 2, 3, 4, 5, 6]) });
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await pending;
    expect(res.success).toBe(false);
  });
});
