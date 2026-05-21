import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TcpTransport } from './tcpTransport.js';

/**
 * Unit tests for TcpTransport heartbeat feature (issue 2609).
 *
 * These tests exercise the heartbeat timer + payload plumbing in isolation
 * from the actual net.Socket. The transport's `send()` method is stubbed, and
 * connected state is injected directly — we're testing heartbeat scheduling
 * logic, not TCP wire behavior.
 */
describe('TcpTransport — heartbeat (issue 2609)', () => {
  let transport: TcpTransport;
  let sendSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    transport = new TcpTransport();
    // Fake being connected so heartbeat paths that check state don't bail
    (transport as any).isConnected = true;
    (transport as any).socket = {
      write: vi.fn((_, cb) => { cb?.(); return true; }),
      removeAllListeners: vi.fn(),
      destroy: vi.fn(),
    };
    sendSpy = vi.spyOn(transport, 'send').mockResolvedValue(undefined);
  });

  afterEach(() => {
    // Always stop the heartbeat so leftover timers don't leak between tests
    (transport as any).stopHeartbeat?.();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not fire heartbeat when interval is 0 (disabled)', () => {
    transport.setHeartbeatInterval(0, () => new Uint8Array([0x01]));
    (transport as any).startHeartbeat();

    vi.advanceTimersByTime(60_000);

    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('fires getPayload + send at the configured interval', async () => {
    const payload = new Uint8Array([0x0a, 0x00]);
    const getPayload = vi.fn().mockReturnValue(payload);

    transport.setHeartbeatInterval(30_000, getPayload);
    (transport as any).startHeartbeat();

    // Nothing fires before the first interval
    vi.advanceTimersByTime(29_999);
    expect(getPayload).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();

    // One tick at the interval
    await vi.advanceTimersByTimeAsync(1);
    expect(getPayload).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith(payload);

    // Two ticks total
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sendSpy).toHaveBeenCalledTimes(2);
  });

  it('accepts an async getPayload factory', async () => {
    const payload = new Uint8Array([0xff]);
    const getPayload = vi.fn().mockResolvedValue(payload);

    transport.setHeartbeatInterval(10_000, getPayload);
    (transport as any).startHeartbeat();

    await vi.advanceTimersByTimeAsync(10_000);

    expect(sendSpy).toHaveBeenCalledWith(payload);
  });

  it('does NOT update lastDataReceived on heartbeat send (kernel buffers mask dead hosts; liveness must come from the firmware reply)', async () => {
    // The firmware replies to every ToRadio.heartbeat with a FromRadio.queueStatus.
    // That reply arrives via handleIncomingData() and refreshes lastDataReceived
    // naturally. Updating lastDataReceived from the *send* side would mask dead
    // hosts because socket.write() to a dead remote keeps "succeeding" for many
    // minutes while the kernel send buffer fills.
    const initial = Date.now() - 3_600_000;
    (transport as any).lastDataReceived = initial;

    transport.setHeartbeatInterval(5_000, () => new Uint8Array([0x00]));
    (transport as any).startHeartbeat();

    await vi.advanceTimersByTimeAsync(5_000);

    expect((transport as any).lastDataReceived).toBe(initial);
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('does not update lastDataReceived when send throws (so stale detector can still fire on dead links)', async () => {
    const getPayload = () => new Uint8Array([0x00]);
    // Make send reject on the heartbeat tick
    sendSpy.mockRejectedValue(new Error('ECONNRESET'));

    const initial = Date.now() - 3_600_000;
    (transport as any).lastDataReceived = initial;

    transport.setHeartbeatInterval(5_000, getPayload);
    (transport as any).startHeartbeat();

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(0); // flush microtasks

    expect((transport as any).lastDataReceived).toBe(initial);
  });

  it('stopHeartbeat prevents further heartbeat fires', async () => {
    transport.setHeartbeatInterval(10_000, () => new Uint8Array([0x00]));
    (transport as any).startHeartbeat();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(sendSpy).toHaveBeenCalledTimes(1);

    (transport as any).stopHeartbeat();
    await vi.advanceTimersByTimeAsync(60_000);

    // Still just the one fire from before stopHeartbeat
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('startHeartbeat is idempotent (calling twice does not stack timers)', async () => {
    transport.setHeartbeatInterval(5_000, () => new Uint8Array([0x00]));
    (transport as any).startHeartbeat();
    (transport as any).startHeartbeat(); // second call should not double-schedule
    (transport as any).startHeartbeat();

    await vi.advanceTimersByTimeAsync(5_000);

    // Exactly one fire, not three
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('setHeartbeatInterval(0) while running stops an active heartbeat', async () => {
    transport.setHeartbeatInterval(5_000, () => new Uint8Array([0x00]));
    (transport as any).startHeartbeat();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(sendSpy).toHaveBeenCalledTimes(1);

    // Disable it and confirm no more fires
    transport.setHeartbeatInterval(0, () => new Uint8Array([0x00]));
    await vi.advanceTimersByTimeAsync(30_000);

    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('disconnect() stops the heartbeat', async () => {
    transport.setHeartbeatInterval(5_000, () => new Uint8Array([0x00]));
    (transport as any).startHeartbeat();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(sendSpy).toHaveBeenCalledTimes(1);

    transport.disconnect();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('does not fire heartbeat when transport is not connected', async () => {
    (transport as any).isConnected = false;

    transport.setHeartbeatInterval(5_000, () => new Uint8Array([0x00]));
    (transport as any).startHeartbeat();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(sendSpy).not.toHaveBeenCalled();
  });
});

/**
 * Unit tests for TcpTransport startup-grace fast reconnect (#3122 follow-up).
 *
 * Passive-mode TCP sources opt into a short grace window during which
 * reconnect attempts use a fixed fast delay instead of exponential backoff.
 * The reporter observed that a large infrastructure node usually closes the
 * first config-sync session but recovers cleanly on the next attempt; the
 * grace shortens the user-visible reconnect gap during that startup window
 * without affecting steady-state backoff.
 */
describe('TcpTransport — startup-grace fast reconnect (#3122)', () => {
  let transport: TcpTransport;
  let doConnectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    transport = new TcpTransport();
    // scheduleReconnect calls doConnect via setTimeout; stub it so the test
    // doesn't try to open a real socket.
    doConnectSpy = vi.spyOn(transport as any, 'doConnect').mockResolvedValue(undefined);
    (transport as any).shouldReconnect = true;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Pulls the next-scheduled delay off the most recent setTimeout call. */
  const scheduleAndReadDelay = (): number => {
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    (transport as any).scheduleReconnect();
    const call = setTimeoutSpy.mock.calls[setTimeoutSpy.mock.calls.length - 1];
    setTimeoutSpy.mockRestore();
    return call?.[1] as number;
  };

  it('disabled by default — uses exponential backoff (1s for first attempt)', () => {
    // First attempt: initialDelay * 2^0 = 1000ms
    const delay = scheduleAndReadDelay();
    expect(delay).toBe(1_000);
  });

  it('inside the grace window: uses the fast delay regardless of attempt count', () => {
    transport.setStartupGraceReconnect(120_000, 3_000);

    // First attempt
    expect(scheduleAndReadDelay()).toBe(3_000);
    // Bump attempts to where exponential backoff would otherwise be 8s,
    // 16s, 32s, etc. — still 3s while in the grace window.
    (transport as any).reconnectAttempts = 4;
    expect(scheduleAndReadDelay()).toBe(3_000);
  });

  it('after the grace window expires: falls back to exponential backoff', () => {
    transport.setStartupGraceReconnect(120_000, 3_000);

    // Set the reconnect attempts so we can verify backoff math after grace
    // expires. attempts=3 means scheduleReconnect bumps to 4 → 2^3 = 8000ms.
    (transport as any).reconnectAttempts = 3;

    // Advance past the 2-minute grace window
    vi.advanceTimersByTime(121_000);

    const delay = scheduleAndReadDelay();
    expect(delay).toBe(8_000);
  });

  it('graceMs=0 disables the grace window (legacy behavior)', () => {
    transport.setStartupGraceReconnect(120_000, 3_000);
    transport.setStartupGraceReconnect(0, 0);

    const delay = scheduleAndReadDelay();
    expect(delay).toBe(1_000); // exponential, attempt #1
  });

  it('grace fast delay does not exceed the configured max (sanity)', () => {
    // Edge case: fast delay set absurdly large — the test just verifies the
    // value is honored as-is (it's not clamped against maxDelayMs because the
    // grace window is meant to be a tight, deterministic delay).
    transport.setStartupGraceReconnect(120_000, 100);

    const delay = scheduleAndReadDelay();
    expect(delay).toBe(100);
  });

  it('reconnect actually fires after the fast delay', async () => {
    transport.setStartupGraceReconnect(120_000, 3_000);

    (transport as any).scheduleReconnect();
    expect(doConnectSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(doConnectSpy).toHaveBeenCalledOnce();
  });
});
