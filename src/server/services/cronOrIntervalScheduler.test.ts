/**
 * Unit tests for CronOrIntervalScheduler (issue #3962 Phase 2 Task 2.2b).
 *
 * Uses vi.useFakeTimers() for interval-mode assertions so ticks can be
 * triggered without real wall-clock delay.  Cron mode is tested for
 * arming/disarming correctness (running getter, invalid-expression guard)
 * without needing to advance croner's internal timer.
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

import { CronOrIntervalScheduler } from './cronOrIntervalScheduler.js';
import type { ScheduleMode } from './cronOrIntervalScheduler.js';
import { logger } from '../../utils/logger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIntervalScheduler(overrides: {
  intervalMs?: number;
  onTick?: () => void | Promise<void>;
  label?: string;
}) {
  const onTick = overrides.onTick ?? vi.fn();
  const mode: ScheduleMode = { kind: 'interval', intervalMs: overrides.intervalMs ?? 1000 };
  const scheduler = new CronOrIntervalScheduler({
    label: overrides.label ?? 'Test:src',
    mode,
    onTick,
  });
  return { scheduler, onTick };
}

function makeCronScheduler(overrides: {
  expression?: string;
  onTick?: () => void | Promise<void>;
  label?: string;
}) {
  const onTick = overrides.onTick ?? vi.fn();
  const mode: ScheduleMode = { kind: 'cron', expression: overrides.expression ?? '*/5 * * * *' };
  const scheduler = new CronOrIntervalScheduler({
    label: overrides.label ?? 'Test:src',
    mode,
    onTick,
  });
  return { scheduler, onTick };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CronOrIntervalScheduler — interval mode', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // ── 1. Interval mode: onTick fires every intervalMs ───────────────────────
  it('fires onTick after intervalMs elapses', async () => {
    const { scheduler, onTick } = makeIntervalScheduler({ intervalMs: 1000 });

    const armed = scheduler.start();
    expect(armed).toBe(true);
    expect(scheduler.running).toBe(true);

    // Nothing fires before the interval elapses.
    expect(onTick).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(onTick).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(onTick).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  // ── 2. stop() halts further ticks ─────────────────────────────────────────
  it('stop() halts further ticks and clears running', async () => {
    const { scheduler, onTick } = makeIntervalScheduler({ intervalMs: 500 });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(500);
    expect(onTick).toHaveBeenCalledTimes(1);

    scheduler.stop();
    expect(scheduler.running).toBe(false);

    // No more ticks after stop, even if time advances.
    await vi.advanceTimersByTimeAsync(2000);
    expect(onTick).toHaveBeenCalledTimes(1);
  });

  // ── 3. start() stop+rearms when already running ───────────────────────────
  it('second start() stop+rearms — only one tick per interval', async () => {
    const { scheduler, onTick } = makeIntervalScheduler({ intervalMs: 1000 });

    scheduler.start();
    scheduler.start(); // stop+rearm: resets the interval timer

    await vi.advanceTimersByTimeAsync(1000);

    // If two intervals were active we'd see 2 ticks; stop+rearm gives 1.
    expect(onTick).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });

  // ── 4. stop() is idempotent ───────────────────────────────────────────────
  it('stop() called multiple times does not throw', () => {
    const { scheduler } = makeIntervalScheduler({});
    scheduler.start();
    scheduler.stop();
    expect(() => scheduler.stop()).not.toThrow();
    expect(scheduler.running).toBe(false);
  });

  // ── 5. running getter reflects state ─────────────────────────────────────
  it('running is false before start and after stop', () => {
    const { scheduler } = makeIntervalScheduler({});
    expect(scheduler.running).toBe(false);
    scheduler.start();
    expect(scheduler.running).toBe(true);
    scheduler.stop();
    expect(scheduler.running).toBe(false);
  });

  // ── 6. async onTick rejection is caught and logged ────────────────────────
  it('async onTick rejection is caught; warns; does not propagate', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    const { scheduler } = makeIntervalScheduler({
      onTick: vi.fn().mockRejectedValue(new Error('tick failure')),
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('tick failure'),
    );

    scheduler.stop();
  });

  // ── 7. sync onTick that throws is caught ─────────────────────────────────
  it('sync onTick that throws is caught; warns; does not propagate', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    const { scheduler } = makeIntervalScheduler({
      onTick: vi.fn().mockImplementation(() => { throw new Error('sync boom'); }),
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('sync boom'),
    );

    scheduler.stop();
  });

  // ── 8. start() returns true for interval mode ─────────────────────────────
  it('start() returns true for interval mode', () => {
    const { scheduler } = makeIntervalScheduler({ intervalMs: 3600000 });
    expect(scheduler.start()).toBe(true);
    scheduler.stop();
  });
});

describe('CronOrIntervalScheduler — cron mode', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── 9. Valid cron arms successfully ───────────────────────────────────────
  it('start() with valid cron expression returns true and running=true', () => {
    const { scheduler } = makeCronScheduler({ expression: '*/5 * * * *' });
    expect(scheduler.running).toBe(false);
    const armed = scheduler.start();
    expect(armed).toBe(true);
    expect(scheduler.running).toBe(true);
    scheduler.stop();
  });

  // ── 10. Invalid cron: start() returns false, no arm, warn logged ──────────
  it('start() with invalid cron returns false, warns, and does not arm', () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    const { scheduler } = makeCronScheduler({ expression: 'not a cron' });

    const armed = scheduler.start();
    expect(armed).toBe(false);
    expect(scheduler.running).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('invalid cron expression'),
    );
  });

  // ── 11. Invalid cron: no fallback to interval ─────────────────────────────
  it('invalid cron does not silently fall back to interval mode', () => {
    // If running stayed false and start() returned false, no interval is active.
    const { scheduler } = makeCronScheduler({ expression: 'INVALID' });
    scheduler.start();
    expect(scheduler.running).toBe(false);
  });

  // ── 12. stop() clears cron job ────────────────────────────────────────────
  it('stop() clears the cron job and sets running=false', () => {
    const { scheduler } = makeCronScheduler({ expression: '0 */6 * * *' });
    scheduler.start();
    expect(scheduler.running).toBe(true);
    scheduler.stop();
    expect(scheduler.running).toBe(false);
  });

  // ── 13. stop+rearm: second start() replaces the first cron job ───────────
  it('second start() stop+rearms the cron — only one job is active', () => {
    const { scheduler } = makeCronScheduler({ expression: '0 */6 * * *' });
    scheduler.start();
    // Calling start() again should stop the first job and arm a new one.
    expect(() => scheduler.start()).not.toThrow();
    expect(scheduler.running).toBe(true);
    scheduler.stop();
  });

  // ── 14. stop() idempotent on cron ─────────────────────────────────────────
  it('stop() called twice on armed cron does not throw', () => {
    const { scheduler } = makeCronScheduler({});
    scheduler.start();
    scheduler.stop();
    expect(() => scheduler.stop()).not.toThrow();
    expect(scheduler.running).toBe(false);
  });
});
