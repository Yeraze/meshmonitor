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
