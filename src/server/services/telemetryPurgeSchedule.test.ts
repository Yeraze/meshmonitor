/**
 * #6354: the startup telemetry purge skips its run on a boot that restored a
 * backup; a normal boot still purges, and the hourly purge always runs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '../../utils/logger.js';
import {
  markRestoreCheckStarted,
  markRestoreCheckFinished,
  markRestoredThisBoot,
  resetRestoreBootStateForTests,
} from './restoreBootState.js';
import {
  TELEMETRY_RETENTION_HOURS,
  FAVORITE_TELEMETRY_DEFAULT_DAYS,
  TELEMETRY_PURGE_INTERVAL_MS,
  TELEMETRY_STARTUP_PURGE_DELAY_MS,
  runStartupTelemetryPurge,
  runScheduledTelemetryPurge,
  startTelemetryPurgeSchedule,
} from './telemetryPurgeSchedule.js';

function makeDb() {
  return {
    waitForReady: vi.fn().mockResolvedValue(undefined),
    purgeOldTelemetryAsync: vi.fn().mockResolvedValue(3),
  };
}

function simulateRestoreBoot(): void {
  markRestoreCheckStarted();
  markRestoredThisBoot();
  markRestoreCheckFinished();
}

describe('telemetryPurgeSchedule (#6354)', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetRestoreBootStateForTests();
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    resetRestoreBootStateForTests();
    vi.useRealTimers();
  });

  it('startup purge runs on a normal boot', async () => {
    markRestoreCheckStarted();
    markRestoreCheckFinished();
    const db = makeDb();
    await expect(runStartupTelemetryPurge(db)).resolves.toBe(3);
    expect(db.purgeOldTelemetryAsync).toHaveBeenCalledWith(TELEMETRY_RETENTION_HOURS, FAVORITE_TELEMETRY_DEFAULT_DAYS);
    expect(warn).not.toHaveBeenCalled();
  });

  it('startup purge is skipped, with a warning naming the window, on a restore boot', async () => {
    simulateRestoreBoot();
    const db = makeDb();
    await expect(runStartupTelemetryPurge(db)).resolves.toBe(0);
    expect(db.purgeOldTelemetryAsync).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(`${TELEMETRY_RETENTION_HOURS}h`);
  });

  it('scheduled purge runs even on a restore boot', async () => {
    simulateRestoreBoot();
    const db = makeDb();
    await expect(runScheduledTelemetryPurge(db)).resolves.toBe(3);
    expect(db.purgeOldTelemetryAsync).toHaveBeenCalledTimes(1);
  });

  it('timers: on a restore boot the 5s run is skipped and the hourly run purges', async () => {
    vi.useFakeTimers();
    simulateRestoreBoot();
    const db = makeDb();
    startTelemetryPurgeSchedule(db);

    await vi.advanceTimersByTimeAsync(TELEMETRY_STARTUP_PURGE_DELAY_MS);
    expect(db.purgeOldTelemetryAsync).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(TELEMETRY_PURGE_INTERVAL_MS);
    expect(db.purgeOldTelemetryAsync).toHaveBeenCalledTimes(1);
    vi.clearAllTimers();
  });

  it('timers: on a normal boot the 5s run purges', async () => {
    vi.useFakeTimers();
    const db = makeDb();
    startTelemetryPurgeSchedule(db);
    await vi.advanceTimersByTimeAsync(TELEMETRY_STARTUP_PURGE_DELAY_MS);
    expect(db.purgeOldTelemetryAsync).toHaveBeenCalledTimes(1);
    vi.clearAllTimers();
  });
});
