/**
 * Tests for MeshCoreNativeBackend's LoginFail (0x86) detection.
 *
 * meshcore.js's `login()` listens only for LoginSuccess (0x85) — its own
 * constants mark LoginFail (0x86) "not usable yet" — so a password the remote
 * actively refuses looks exactly like a reply that never arrived: the promise
 * just sits there until it times out. That ambiguity is what let the room-sync
 * scheduler keep re-flooding a password the room server had already rejected.
 *
 * The firmware does send 0x86 (ripplebiz/MeshCore
 * examples/companion_radio/MyMesh.cpp, onContactResponse):
 *   [0x86] [reserved = 0] [pub_key_prefix 6B]
 * so the backend reads it off the raw frame stream — the same technique the
 * 0x8D and 0x8E handlers use for push codes meshcore.js does not parse — and
 * races it against login(), surfacing MESHCORE_LOGIN_REJECTED.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import {
  MeshCoreNativeBackend,
  MESHCORE_LOGIN_REJECTED,
  __setMeshCoreModule,
} from './meshcoreNativeBackend.js';

const PUSH_LOGIN_FAIL = 0x86;

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

const ROOM_KEY_HEX = 'b1b2b3b4b5b6' + 'cc'.repeat(26);

function hexToBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.substring(i, i + 2), 16));
  return out;
}

/** Wire-format LoginFail push for `pubkeyHex`'s first six bytes. */
function buildLoginFailFrame(pubkeyHex: string): Uint8Array {
  return Uint8Array.from([
    PUSH_LOGIN_FAIL,
    0, // reserved
    ...hexToBytes(pubkeyHex.substring(0, 12)),
  ]);
}

class MockConnection extends EventEmitter {
  /** Resolved by an explicit LoginSuccess; never resolved otherwise, standing
   *  in for meshcore.js's behaviour of waiting out the timeout on a refusal. */
  loginCalls: Array<{ publicKey: Uint8Array; password: string }> = [];
  private resolveLogin: ((value: unknown) => void) | null = null;

  async connect() { /* no-op */ }
  async close() { /* no-op */ }
  async getSelfInfo() {
    return { type: AdvType.Chat, publicKey: Uint8Array.from(Array(32).fill(0)), name: 'TestNode' };
  }
  async getContacts() {
    return [{ publicKey: Uint8Array.from(hexToBytes(ROOM_KEY_HEX)), advType: AdvType.Room }];
  }
  sendToRadioFrame(_frame: Uint8Array) { /* no-op */ }

  login(publicKey: Uint8Array, password: string) {
    this.loginCalls.push({ publicKey, password });
    return new Promise((resolve) => {
      this.resolveLogin = resolve;
    });
  }

  /** Simulate the LoginSuccess path. */
  succeedLogin(payload: Record<string, unknown> = {}) {
    this.resolveLogin?.(payload);
  }
}

function installMockModule(): void {
  __setMeshCoreModule({
    NodeJSSerialConnection: MockConnection as any,
    TCPConnection: MockConnection as any,
    Constants: { ResponseCodes, PushCodes, AdvType, TxtTypes } as any,
    CayenneLpp: { parse: () => [] } as any,
    Packet: {} as any,
  });
}

async function connectedBackend(): Promise<{ backend: MeshCoreNativeBackend; conn: MockConnection }> {
  const backend = new MeshCoreNativeBackend('src-login', {
    connectionType: 'serial',
    serialPort: '/dev/ttyUSB0',
  });
  await backend.connect();
  return { backend, conn: (backend as any).connection as MockConnection };
}

describe('MeshCoreNativeBackend — LoginFail (0x86)', () => {
  beforeEach(() => {
    installMockModule();
  });

  afterEach(() => {
    __setMeshCoreModule(null as any);
  });

  it('surfaces a refusal as MESHCORE_LOGIN_REJECTED instead of waiting for the timeout', async () => {
    const { backend, conn } = await connectedBackend();

    const pending = backend.sendCommand('login', { public_key: ROOM_KEY_HEX, password: 'wrong' });
    // Let the dispatch reach c.login() and attach the raw listener.
    await new Promise((r) => setTimeout(r, 0));
    conn.emit('rx', buildLoginFailFrame(ROOM_KEY_HEX));

    const res = await pending;
    expect(res.success).toBe(false);
    expect(res.error).toBe(MESHCORE_LOGIN_REJECTED);
  });

  it('ignores a refusal aimed at a different contact', async () => {
    const { backend, conn } = await connectedBackend();

    const pending = backend.sendCommand('login', { public_key: ROOM_KEY_HEX, password: 'right' });
    await new Promise((r) => setTimeout(r, 0));

    // The push carries no request tag, only a key prefix — two overlapping
    // logins would otherwise cross wires.
    conn.emit('rx', buildLoginFailFrame('a1a2a3a4a5a6' + 'dd'.repeat(26)));
    await new Promise((r) => setTimeout(r, 0));
    conn.succeedLogin({ isAdmin: 1 });

    const res = await pending;
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ ok: true, is_admin: 1 });
  });

  it('ignores frames that are not LoginFail', async () => {
    const { backend, conn } = await connectedBackend();

    const pending = backend.sendCommand('login', { public_key: ROOM_KEY_HEX, password: 'right' });
    await new Promise((r) => setTimeout(r, 0));

    conn.emit('rx', Uint8Array.from([0x8d, 0, ...hexToBytes(ROOM_KEY_HEX.substring(0, 12))]));
    await new Promise((r) => setTimeout(r, 0));
    conn.succeedLogin({});

    expect((await pending).success).toBe(true);
  });

  it('detaches its listener once the login settles', async () => {
    const { backend, conn } = await connectedBackend();

    const before = conn.listenerCount('rx');
    const pending = backend.sendCommand('login', { public_key: ROOM_KEY_HEX, password: 'right' });
    await new Promise((r) => setTimeout(r, 0));
    expect(conn.listenerCount('rx')).toBe(before + 1);

    conn.succeedLogin({});
    await pending;

    // A leaked listener per login attempt would accumulate across every
    // scheduled room sync for the life of the connection.
    expect(conn.listenerCount('rx')).toBe(before);
  });
});
