import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Regression tests for the transport-level half of issue #3270.
 *
 * #3276 added a teardown in MeshtasticManager.connect(), but that can only
 * reach the transport the manager currently references. The residual flap the
 * reporter measured on PR #3276 was driven entirely by TcpTransport's own
 * auto-reconnect loop (scheduleReconnect → doConnect on socket 'close'). These
 * tests harden the transport itself so it cannot become a self-reconnecting
 * zombie:
 *
 *   1. Once disconnect()ed, a transport must never reconnect again — even if a
 *      late scheduleReconnect() arrives (a queued 'close' handler, a racing
 *      timer). Before this fix scheduleReconnect() scheduled a doConnect
 *      unconditionally, with no "I've been torn down" guard.
 *   2. doConnect() must tear down any pre-existing socket before opening a new
 *      one, so a single transport can never leak two live sockets at the
 *      daemon (the 2:1 force-close fingerprint).
 *
 * `net` is mocked so doConnect() never opens a real socket.
 */

const createdSockets: any[] = [];

vi.mock('net', () => {
  class FakeSocket {
    setKeepAlive = vi.fn();
    setNoDelay = vi.fn();
    on = vi.fn();
    once = vi.fn();
    removeAllListeners = vi.fn();
    destroy = vi.fn();
    connect = vi.fn();
    write = vi.fn();
    constructor() {
      createdSockets.push(this);
    }
  }
  return { Socket: FakeSocket };
});

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('TcpTransport — orphan/zombie reconnect guard (#3270)', () => {
  let TcpTransport: any;

  beforeEach(async () => {
    vi.useFakeTimers();
    createdSockets.length = 0;
    ({ TcpTransport } = await import('./tcpTransport.js'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not reconnect after disconnect(), even if scheduleReconnect() fires late', () => {
    const t = new TcpTransport();
    (t as any).config = { host: '127.0.0.1', port: 4403 };
    const doConnectSpy = vi.spyOn(t as any, 'doConnect').mockResolvedValue(undefined);

    // Operator/manager tears the transport down.
    t.disconnect();

    // A late 'close' handler (or any straggler) tries to reschedule a reconnect.
    (t as any).scheduleReconnect();
    vi.advanceTimersByTime(120_000);

    // The torn-down transport must stay dead — no resurrection.
    expect(doConnectSpy).not.toHaveBeenCalled();
  });

  it('doConnect() tears down a pre-existing socket before opening a new one', () => {
    const t = new TcpTransport();
    (t as any).config = { host: '127.0.0.1', port: 4403 };

    const staleSocket = {
      removeAllListeners: vi.fn(),
      destroy: vi.fn(),
    };
    (t as any).socket = staleSocket;

    // Kick off a connect. We don't await it (the fake socket never fires
    // 'connect'); we only care that the stale socket was reclaimed.
    void (t as any).doConnect();

    expect(staleSocket.removeAllListeners).toHaveBeenCalled();
    expect(staleSocket.destroy).toHaveBeenCalled();
    // Exactly one new socket was constructed for this attempt.
    expect(createdSockets.length).toBe(1);
  });

  it('public connect() re-arms a previously disconnected transport', async () => {
    const t = new TcpTransport();
    const doConnectSpy = vi.spyOn(t as any, 'doConnect').mockResolvedValue(undefined);

    t.disconnect();
    // A brand-new explicit connect() is a fresh intent and must be honored.
    await t.connect('127.0.0.1', 4403);

    expect(doConnectSpy).toHaveBeenCalledTimes(1);
    expect((t as any).shouldReconnect).toBe(true);
  });
});
