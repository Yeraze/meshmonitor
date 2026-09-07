/**
 * Connect-timeout lifetime + teardown observability (#5122).
 *
 * A reporter's packet capture showed MeshMonitor sending the first FIN on a
 * healthy, mid-sync connection with nothing in the application log — no stale
 * connection warning, no error, just a clean client-initiated close followed by
 * a reconnect. Two properties of the old code made that shape possible:
 *
 *  1. The connect timeout lived in `doConnect()`'s closure and read
 *     `this.socket` when it fired, not the socket it was armed for. Every
 *     teardown path strips the socket's listeners (otherwise a deliberate close
 *     looks like a lost link and triggers auto-reconnect), which removes the
 *     very handlers that cancelled the timer — so it could outlive its own
 *     attempt and then destroy whatever socket happened to be current.
 *  2. Those teardown paths destroyed the socket in silence, so nothing in the
 *     log attributed the FIN to anything.
 *
 * These tests drive the real `doConnect()` against a fake `net.Socket` and pin
 * both properties: a timer can only ever kill the attempt it belongs to, and
 * every socket we close deliberately says who closed it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const createdSockets: any[] = [];

vi.mock('net', () => {
  class FakeSocket {
    handlers: Record<string, Array<(...a: any[]) => void>> = {};
    setKeepAlive = vi.fn();
    setNoDelay = vi.fn();
    connect = vi.fn();
    write = vi.fn();
    destroy = vi.fn();
    removeAllListeners = vi.fn(() => { this.handlers = {}; });
    on = vi.fn((ev: string, fn: (...a: any[]) => void) => {
      (this.handlers[ev] ||= []).push(fn);
      return this;
    });
    once = vi.fn((ev: string, fn: (...a: any[]) => void) => {
      (this.handlers[ev] ||= []).push(fn);
      return this;
    });
    emit(ev: string, ...args: any[]) {
      for (const fn of this.handlers[ev] ?? []) fn(...args);
    }
    constructor() { createdSockets.push(this); }
  }
  return { Socket: FakeSocket };
});

const logs = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
vi.mock('../utils/logger.js', () => ({ logger: logs }));

let TcpTransport: any;

const newTransport = async (connectTimeoutMs = 10_000) => {
  const t = new TcpTransport();
  t.setConnectTimeout(connectTimeoutMs);
  // Never let the auto-reconnect loop open a second socket mid-test.
  vi.spyOn(t as any, 'scheduleReconnect').mockImplementation(() => {});
  return t;
};

beforeEach(async () => {
  vi.useFakeTimers();
  createdSockets.length = 0;
  for (const fn of Object.values(logs)) fn.mockClear();
  ({ TcpTransport } = await import('./tcpTransport.js'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('TcpTransport — connect timeout lifetime (#5122)', () => {
  it('cancels the pending connect timeout when the attempt is torn down', async () => {
    const t = await newTransport();
    t.connect('node.example', 4403).catch(() => {});

    // Torn down while still connecting. This is the path that used to leave a
    // live timer behind: disconnect() strips the listeners that would have
    // cancelled it, and never touched the timer itself.
    t.disconnect();
    expect((t as any).connectTimeout).toBeNull();

    // A later attempt on the same transport gets its own socket...
    t.connect('node.example', 4403).catch(() => {});
    const second = createdSockets[1];
    second.emit('connect');
    expect(t.getConnectionState()).toBe(true);

    // ...which the first attempt's timer must not be able to reach.
    vi.advanceTimersByTime(120_000);
    expect(second.destroy).not.toHaveBeenCalled();
    expect(t.getConnectionState()).toBe(true);
  });

  it('a superseded timer never destroys the socket that replaced it', async () => {
    const t = await newTransport();
    t.connect('node.example', 4403).catch(() => {});
    const first = createdSockets[0];

    // doConnect() reclaims the in-flight socket and opens another. Before the
    // fix, the first attempt's timer was still armed and read `this.socket`,
    // so it would have destroyed this healthy replacement.
    void (t as any).doConnect().catch(() => {});
    const second = createdSockets[1];
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    second.emit('connect');

    vi.advanceTimersByTime(120_000);
    expect(second.destroy).not.toHaveBeenCalled();
    expect(t.getConnectionState()).toBe(true);
  });

  it('does not fire once the attempt has connected', async () => {
    const t = await newTransport();
    t.connect('node.example', 4403).catch(() => {});
    const socket = createdSockets[0];
    socket.emit('connect');

    vi.advanceTimersByTime(120_000);

    expect(socket.destroy).not.toHaveBeenCalled();
    expect(t.getConnectionState()).toBe(true);
  });

  it('still destroys its own socket, loudly, when the attempt really does hang', async () => {
    const t = await newTransport(10_000);
    const attempt = t.connect('node.example', 4403);
    const rejection = expect(attempt).rejects.toThrow(/Connection timeout/);
    const socket = createdSockets[0];

    vi.advanceTimersByTime(10_000);

    expect(socket.destroy).toHaveBeenCalledTimes(1);
    // The old code destroyed the socket with no log at all.
    expect(logs.warn.mock.calls.map((c) => String(c[0])).join('\n'))
      .toMatch(/TCP connect to node\.example:4403 timed out after 10000ms/);
    await rejection;
  });
});

describe('TcpTransport — teardown says who closed the socket (#5122)', () => {
  it('logs at info when a LIVE connection is closed deliberately', async () => {
    const t = await newTransport();
    t.connect('node.example', 4403).catch(() => {});
    const socket = createdSockets[0];
    socket.emit('connect');

    t.disconnect();

    // A packet capture shows a client-initiated FIN at this moment; the log has
    // to be able to explain it, which before this change it could not.
    expect(socket.destroy).toHaveBeenCalled();
    const line = logs.info.mock.calls.map((c) => String(c[0])).join('\n');
    expect(line).toMatch(/Closing the live TCP connection to node\.example:4403/);
    expect(line).toMatch(/disconnect\(\) was called/);
  });

  it('names the reclaim path when a new attempt takes over an existing socket', async () => {
    const t = await newTransport();
    t.connect('node.example', 4403).catch(() => {});
    createdSockets[0].emit('connect');
    logs.info.mockClear();

    void (t as any).doConnect().catch(() => {});

    expect(logs.info.mock.calls.map((c) => String(c[0])).join('\n'))
      .toMatch(/reclaimed before a new connect attempt/);
  });

  it('stays at debug for a socket that was never connected', async () => {
    const t = await newTransport();
    t.connect('node.example', 4403).catch(() => {});

    t.disconnect();

    expect(createdSockets[0].destroy).toHaveBeenCalled();
    expect(logs.info).not.toHaveBeenCalled();
  });

  it('clears the socket reference so a second teardown is a no-op', async () => {
    const t = await newTransport();
    t.connect('node.example', 4403).catch(() => {});
    createdSockets[0].emit('connect');

    t.disconnect();
    t.disconnect();

    expect(createdSockets[0].destroy).toHaveBeenCalledTimes(1);
  });
});
