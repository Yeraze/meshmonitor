/**
 * Unit tests for HeartbeatScheduler (issue #3962 Phase 2 Task 2.2a).
 *
 * Uses vi.useFakeTimers() so every gate and branch can be asserted
 * without real network or hardware.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import { HeartbeatScheduler } from './heartbeatScheduler.js';
import { logger } from '../../utils/logger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeScheduler(overrides: Partial<{
  intervalMs: number;
  timeoutMs: number;
  probe: (t: number) => Promise<boolean>;
  isConnected: () => boolean;
  onSuccess: (ms: number) => void;
  onFailure: (e: Error) => void;
}> = {}) {
  const probe = overrides.probe ?? vi.fn().mockResolvedValue(true);
  const isConnected = overrides.isConnected ?? vi.fn().mockReturnValue(true);
  const onSuccess = overrides.onSuccess ?? vi.fn();
  const onFailure = overrides.onFailure ?? vi.fn();

  const scheduler = new HeartbeatScheduler({
    label: 'Test:src',
    intervalMs: overrides.intervalMs ?? 1000,
    timeoutMs: overrides.timeoutMs ?? 500,
    probe,
    isConnected,
    onSuccess,
    onFailure,
  });

  return { scheduler, probe, isConnected, onSuccess, onFailure };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HeartbeatScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // ── 1. Happy path ─────────────────────────────────────────────────────────
  it('fires probe after intervalMs and calls onSuccess with non-negative latencyMs', async () => {
    const { scheduler, probe, onSuccess } = makeScheduler({ intervalMs: 1000 });

    scheduler.start();
    expect(scheduler.running).toBe(true);

    // Nothing happens before the interval fires.
    expect(probe).not.toHaveBeenCalled();

    // Advance past one interval; let microtasks flush.
    await vi.advanceTimersByTimeAsync(1000);

    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(500);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    const [latencyMs] = (onSuccess as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(latencyMs).toBeGreaterThanOrEqual(0);

    scheduler.stop();
  });

  // ── 2. Idempotent start ───────────────────────────────────────────────────
  it('second start() call is a no-op — only one probe fires per interval', async () => {
    const { scheduler, probe } = makeScheduler({ intervalMs: 1000 });

    scheduler.start();
    scheduler.start(); // should be ignored

    await vi.advanceTimersByTimeAsync(1000);

    // Exactly one probe per interval tick, not two.
    expect(probe).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });

  // ── 3. In-flight guard ────────────────────────────────────────────────────
  it('in-flight guard: a slow probe blocks the next tick from starting a second probe', async () => {
    let resolveProbe!: () => void;
    const slowProbe = vi.fn(
      () =>
        new Promise<boolean>((res) => {
          resolveProbe = () => res(true);
        }),
    );
    const { scheduler, onSuccess } = makeScheduler({ probe: slowProbe, intervalMs: 500 });

    scheduler.start();

    // First tick: probe starts and stays in flight.
    await vi.advanceTimersByTimeAsync(500);
    expect(slowProbe).toHaveBeenCalledTimes(1);

    // Second tick fires while probe is still pending — must be skipped.
    await vi.advanceTimersByTimeAsync(500);
    expect(slowProbe).toHaveBeenCalledTimes(1); // still 1

    // Now resolve the first probe.
    resolveProbe();
    await vi.advanceTimersByTimeAsync(0); // flush microtasks

    expect(onSuccess).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });

  // ── 4. Pre-gate (isConnected false before probe) ──────────────────────────
  it('pre-gate: skips probe entirely when isConnected() returns false', async () => {
    const { scheduler, probe, onSuccess, onFailure } = makeScheduler({
      isConnected: vi.fn().mockReturnValue(false),
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(probe).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();

    scheduler.stop();
  });

  // ── 5. Post-await gate (isConnected goes false while probe is in flight) ──
  it('post-await gate: drops the probe result when isConnected() is false after awaiting', async () => {
    let resolveProbe!: () => void;
    const slowProbe = vi.fn(
      () =>
        new Promise<boolean>((res) => {
          resolveProbe = () => res(true);
        }),
    );
    const connected = { value: true };
    const isConnected = vi.fn(() => connected.value);
    const { scheduler, onSuccess, onFailure } = makeScheduler({
      probe: slowProbe,
      isConnected,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(1000); // probe starts
    expect(slowProbe).toHaveBeenCalledTimes(1);

    // Link goes down while probe is pending.
    connected.value = false;

    // Probe resolves — result must be dropped.
    resolveProbe();
    await vi.advanceTimersByTimeAsync(0);

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();

    scheduler.stop();
  });

  // ── 6a. Probe resolves false ──────────────────────────────────────────────
  it('probe resolving false calls onFailure with an Error', async () => {
    const { scheduler, onFailure } = makeScheduler({
      probe: vi.fn().mockResolvedValue(false),
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect((onFailure as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBeInstanceOf(Error);

    scheduler.stop();
  });

  // ── 6b. Probe rejects ────────────────────────────────────────────────────
  it('probe rejecting calls onFailure with the thrown error', async () => {
    const probeError = new Error('device unreachable');
    const { scheduler, onFailure } = makeScheduler({
      probe: vi.fn().mockRejectedValue(probeError),
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect((onFailure as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(probeError);

    scheduler.stop();
  });

  // ── 7. stop() ─────────────────────────────────────────────────────────────
  it('stop() halts further probes and clears the in-flight flag', async () => {
    const { scheduler, probe } = makeScheduler({ intervalMs: 1000 });

    scheduler.start();
    scheduler.stop();
    expect(scheduler.running).toBe(false);

    // No probes should fire after stop, even if we advance time.
    await vi.advanceTimersByTimeAsync(5000);
    expect(probe).not.toHaveBeenCalled();
  });

  // ── 8. Interval callback swallows an unexpected throw from runProbe ────────
  it('interval callback .catch() swallows a throw from a misbehaving onFailure callback', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');

    // probe rejects → the catch block in runProbe calls onFailure → onFailure
    // also throws.  That secondary throw escapes the catch block and becomes a
    // rejection on the runProbe() Promise, which is caught by the interval
    // wrapper's .catch() and logged as "heartbeat probe threw:".
    const { scheduler } = makeScheduler({
      probe: vi.fn().mockRejectedValue(new Error('probe rejected')),
      onFailure: vi.fn().mockImplementation(() => {
        throw new Error('failure handler exploded');
      }),
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('heartbeat probe threw: failure handler exploded'),
    );

    scheduler.stop();
  });
});
