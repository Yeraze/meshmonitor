/**
 * Config-sync stall watchdog (#5122, Bug B).
 *
 * A reporter watched a node go silent part-way through the initial NodeDB sync
 * and stay that way: no data, no error, no FIN. MeshMonitor's own state kept
 * reporting `isConnected=true, nodeResponsive=true, configuring=true` for 70+
 * seconds with zero reconnect attempts, until the container was killed by hand.
 *
 * The only liveness guard was the idle watchdog — 5 minutes by default, polled
 * once a minute — so a stalled sync could sit undetected for the better part of
 * five minutes. That is a distinct failure from an idle link: the peer has
 * stopped part-way through a stream it will never resume, so waiting cannot
 * help. These tests pin the tighter budget and, just as importantly, that it
 * applies ONLY while a sync is running.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TcpTransport } from './tcpTransport.js';

describe('TcpTransport — config-sync stall watchdog (#5122)', () => {
  let transport: any;
  let socket: { destroy: ReturnType<typeof vi.fn>; removeAllListeners: ReturnType<typeof vi.fn> };
  let stale: unknown[];

  beforeEach(() => {
    vi.useFakeTimers();
    transport = new TcpTransport();
    transport.config = { host: 'node.example', port: 4403 };
    socket = { destroy: vi.fn(), removeAllListeners: vi.fn() };
    transport.socket = socket;
    transport.isConnected = true;
    transport.lastDataReceived = Date.now();
    transport.lastMessageEmitted = Date.now();
    stale = [];
    transport.on('stale-connection', (info: unknown) => stale.push(info));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Pretend `ms` passed with nothing arriving, then run one health check. */
  const silentFor = (ms: number) => {
    transport.lastDataReceived = Date.now() - ms;
    transport.lastMessageEmitted = Date.now() - ms;
    transport.checkConnection();
  };

  it('tears down a sync that has been silent past the 60s budget', () => {
    transport.setConfigSyncActive(true);

    silentFor(61_000);

    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(stale).toHaveLength(1);
    expect((stale[0] as { phase: string }).phase).toBe('config-sync');
  });

  it('tolerates the bursty pacing a large NodeDB actually has', () => {
    // The same reporter measured ~10s of true wire silence between NodeInfo
    // bursts on a healthy sync. A budget that trips on those would replace a
    // rare hang with a guaranteed reconnect loop.
    transport.setConfigSyncActive(true);

    silentFor(12_000);
    silentFor(30_000);
    silentFor(59_000);

    expect(socket.destroy).not.toHaveBeenCalled();
    expect(stale).toEqual([]);
  });

  it('does not apply the tight budget once the sync has finished', () => {
    // Post-sync, an idle link is normal — that is the 5-minute watchdog's job,
    // and it must not be tightened to 60s by accident.
    transport.setConfigSyncActive(true);
    transport.setConfigSyncActive(false);

    silentFor(120_000);

    expect(socket.destroy).not.toHaveBeenCalled();
    expect(stale).toEqual([]);
  });

  it('never applies the tight budget when no sync was ever announced', () => {
    silentFor(120_000);

    expect(socket.destroy).not.toHaveBeenCalled();
    expect(stale).toEqual([]);
  });

  it('still lets the ordinary idle watchdog trip after the sync ends', () => {
    transport.setConfigSyncActive(false);
    transport.setStaleConnectionTimeout(300_000);

    silentFor(301_000);

    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect((stale[0] as { phase?: string }).phase).toBeUndefined();
  });

  it('stays disabled when the operator has turned stale detection off entirely', () => {
    // Setting the timeout to 0 is an explicit "stop policing this link". The
    // sync watchdog rides the same health check and deliberately does not
    // override that choice.
    transport.setStaleConnectionTimeout(0);
    transport.setConfigSyncActive(true);

    silentFor(120_000);

    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it('polls fast enough that a 60s budget is not detected two minutes late', () => {
    // A 60s budget on the default 60s poll would take up to 120s to notice.
    transport.setConfigSyncActive(true);
    transport.startHealthCheck();
    const check = vi.spyOn(transport, 'checkConnection');

    vi.advanceTimersByTime(60_000);

    expect(check.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('re-arms the health check when a sync starts on a live connection', () => {
    transport.startHealthCheck();
    const before = transport.healthCheckInterval;

    transport.setConfigSyncActive(true);

    // A new timer, so the faster cadence applies now rather than at the next
    // minute boundary — which on a stalling sync is the whole margin.
    expect(transport.healthCheckInterval).not.toBe(before);
  });

  it('is idempotent — repeating the same state does not churn the timer', () => {
    transport.startHealthCheck();
    transport.setConfigSyncActive(true);
    const armed = transport.healthCheckInterval;

    transport.setConfigSyncActive(true);

    expect(transport.healthCheckInterval).toBe(armed);
  });
});
