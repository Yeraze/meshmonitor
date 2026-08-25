/**
 * MeshCore native backend — connect-failure serial teardown (#4922).
 *
 * Regression guard for the USB unplug/replug lockup: when the SelfInfo
 * handshake fails right after the transport opens (the common case right after
 * a physical replug, while the device is still re-enumerating), the backend
 * MUST close the underlying connection before rethrowing. Otherwise the serial
 * fd lingers open, keeps the OS-level device-node lock, and every subsequent
 * open on the same path fails with "Cannot lock port" until the process
 * restarts.
 *
 * The library-level half of the fix (opening with lock:false + awaiting open)
 * lives in the pinned Yeraze/meshcore.js fork; this file proves the backend's
 * own teardown contract, which is what MeshMonitor controls directly.
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

/**
 * A serial connection whose transport opens but whose SelfInfo handshake
 * rejects — the exact shape of a device that is present but not yet answering
 * (mid-reboot after a replug). `close` is a spy so the test can assert the fd
 * is released on the failure path.
 */
class HandshakeFailsConnection extends EventEmitter {
  connect = vi.fn(async () => { /* transport opens fine */ });
  close = vi.fn(async () => { /* releases the fd */ });
  getSelfInfo = vi.fn(async () => {
    throw new Error('SelfInfo timeout');
  });
  emit(eventName: PropertyKey, ...args: unknown[]): boolean {
    return super.emit(eventName as string | symbol, ...args);
  }
}

/** A connection that connects and answers SelfInfo cleanly. */
class HappyConnection extends EventEmitter {
  connect = vi.fn(async () => { /* ok */ });
  close = vi.fn(async () => { /* ok */ });
  getSelfInfo = vi.fn(async () => ({
    type: AdvType.Chat,
    publicKey: Uint8Array.from(Array(32).fill(0)),
    name: 'TestNode',
  }));
  emit(eventName: PropertyKey, ...args: unknown[]): boolean {
    return super.emit(eventName as string | symbol, ...args);
  }
}

let lastConnection: HandshakeFailsConnection | HappyConnection | null = null;

function installMockModule(ConnCtor: new () => EventEmitter): void {
  // Capture the instance the backend constructs so the test can inspect it.
  class Capturing extends ConnCtor {
    constructor() {
      super();
      lastConnection = this as unknown as HandshakeFailsConnection | HappyConnection;
    }
  }
  const mod = {
    NodeJSSerialConnection: Capturing,
    TCPConnection: Capturing,
    Constants: {
      ResponseCodes, PushCodes, StatsTypes, SelfAdvertTypes,
      BinaryRequestTypes, AdvType, TxtTypes,
    },
    CayenneLpp: { parse: () => [] },
    Packet: {},
  };
  // The real meshcore.js module is untyped; cast through `unknown` (not `any`,
  // to satisfy the no-explicit-any ratchet) to the setter's parameter type.
  __setMeshCoreModule(mod as unknown as Parameters<typeof __setMeshCoreModule>[0]);
}

describe('MeshCoreNativeBackend connect-failure teardown (#4922)', () => {
  beforeEach(() => { lastConnection = null; });
  afterEach(() => __setMeshCoreModule(null));

  it('closes the serial connection and clears it when the handshake fails', async () => {
    installMockModule(HandshakeFailsConnection);
    const backend = new MeshCoreNativeBackend('src-4922', {
      connectionType: 'serial',
      serialPort: '/dev/ttyUSB0',
    });

    await expect(backend.connect()).rejects.toThrow('SelfInfo timeout');

    const conn = lastConnection as HandshakeFailsConnection;
    expect(conn.connect).toHaveBeenCalledTimes(1);
    // The fd MUST be released on the failure path — this is the fix.
    expect(conn.close).toHaveBeenCalledTimes(1);
    // And the dead connection must not linger on the backend.
    expect((backend as unknown as { connection: unknown }).connection).toBeNull();
    expect(backend.isConnected()).toBe(false);
  });

  it('leaves the connection open on a successful connect', async () => {
    installMockModule(HappyConnection);
    const backend = new MeshCoreNativeBackend('src-4922-ok', {
      connectionType: 'serial',
      serialPort: '/dev/ttyUSB0',
    });

    await backend.connect();

    const conn = lastConnection as HappyConnection;
    expect(conn.connect).toHaveBeenCalledTimes(1);
    expect(conn.close).not.toHaveBeenCalled();
    expect(backend.isConnected()).toBe(true);
  });
});
