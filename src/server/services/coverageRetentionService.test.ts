/**
 * Tests for the Coverage Report retention sweep (#5277 Phase 1 WP2 +
 * Phase 4b WP1).
 *
 * `coverageRetentionService` must NOT auto-start on import — importing this
 * module in any other test file must never spin up a live timer — so every
 * test here calls `start()`/`stop()` explicitly and always `stop()`s in
 * `afterEach` to avoid leaking timers across test files.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { getSettingAsyncMock, purgeOlderThanMock, getExemptionWindowsMock } = vi.hoisted(() => ({
  getSettingAsyncMock: vi.fn(),
  purgeOlderThanMock: vi.fn(),
  getExemptionWindowsMock: vi.fn(),
}));

vi.mock('../../services/database.js', () => {
  const shared = {
    getSettingAsync: getSettingAsyncMock,
    coverageReceptions: {
      purgeOlderThan: purgeOlderThanMock,
    },
    coverageSurveys: {
      getExemptionWindows: getExemptionWindowsMock,
    },
  };
  return { default: shared, databaseService: shared };
});

import { coverageRetentionService } from './coverageRetentionService.js';

describe('coverageRetentionService', () => {
  beforeEach(() => {
    getSettingAsyncMock.mockReset();
    purgeOlderThanMock.mockReset();
    purgeOlderThanMock.mockResolvedValue(0);
    getExemptionWindowsMock.mockReset();
    getExemptionWindowsMock.mockResolvedValue([]);
  });

  afterEach(() => {
    coverageRetentionService.stop();
    vi.useRealTimers();
  });

  describe('getRetentionDays()', () => {
    it('clamps an over-max value to 90', async () => {
      getSettingAsyncMock.mockResolvedValue('500');
      await expect(coverageRetentionService.getRetentionDays()).resolves.toBe(90);
    });

    it('defaults to 7 when the setting is missing (null)', async () => {
      getSettingAsyncMock.mockResolvedValue(null);
      await expect(coverageRetentionService.getRetentionDays()).resolves.toBe(7);
    });

    it('clamps a below-min value to 1', async () => {
      getSettingAsyncMock.mockResolvedValue('0');
      await expect(coverageRetentionService.getRetentionDays()).resolves.toBe(1);
    });

    it('passes through a valid in-range value', async () => {
      getSettingAsyncMock.mockResolvedValue('14');
      await expect(coverageRetentionService.getRetentionDays()).resolves.toBe(14);
    });
  });

  describe('runCleanup()', () => {
    it('computes cutoff = now - retentionDays * 86_400_000 and purges it', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-10T00:00:00.000Z'));
      getSettingAsyncMock.mockResolvedValue('7');

      await coverageRetentionService.runCleanup();

      expect(purgeOlderThanMock).toHaveBeenCalledTimes(1);
      const expectedCutoff = new Date('2026-01-10T00:00:00.000Z').getTime() - 7 * 24 * 60 * 60 * 1000;
      expect(purgeOlderThanMock).toHaveBeenCalledWith(expectedCutoff, []);
    });

    it('loads the survey exemption windows and passes them straight through to purgeOlderThan (#5277 Phase 4b WP1)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-10T00:00:00.000Z'));
      getSettingAsyncMock.mockResolvedValue('7');
      const windows = [
        { senderId: '!aaaaaaaa', startAt: 1000, endAt: 2000 },
        { senderId: 'b'.repeat(64), startAt: 5000, endAt: 6000 },
      ];
      getExemptionWindowsMock.mockResolvedValue(windows);

      await coverageRetentionService.runCleanup();

      expect(getExemptionWindowsMock).toHaveBeenCalledTimes(1);
      expect(getExemptionWindowsMock).toHaveBeenCalledWith(Date.now());
      expect(purgeOlderThanMock).toHaveBeenCalledTimes(1);
      const expectedCutoff = new Date('2026-01-10T00:00:00.000Z').getTime() - 7 * 24 * 60 * 60 * 1000;
      expect(purgeOlderThanMock).toHaveBeenCalledWith(expectedCutoff, windows);
    });

    it('logs and does not throw when the purge rejects', async () => {
      getSettingAsyncMock.mockResolvedValue('7');
      purgeOlderThanMock.mockRejectedValueOnce(new Error('db unavailable'));

      await expect(coverageRetentionService.runCleanup()).resolves.toBeUndefined();
    });

    it('logs and does not throw when loading exemption windows rejects', async () => {
      getSettingAsyncMock.mockResolvedValue('7');
      getExemptionWindowsMock.mockRejectedValueOnce(new Error('db unavailable'));

      await expect(coverageRetentionService.runCleanup()).resolves.toBeUndefined();
      expect(purgeOlderThanMock).not.toHaveBeenCalled();
    });

    it('does not throw when getSettingAsync rejects', async () => {
      getSettingAsyncMock.mockRejectedValueOnce(new Error('settings unavailable'));

      await expect(coverageRetentionService.runCleanup()).resolves.toBeUndefined();
      expect(purgeOlderThanMock).not.toHaveBeenCalled();
    });
  });

  describe('start()/stop()', () => {
    it('does not auto-start on import — no sweep before start() is called', async () => {
      vi.useFakeTimers();
      getSettingAsyncMock.mockResolvedValue('7');

      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);

      expect(purgeOlderThanMock).not.toHaveBeenCalled();
    });

    it('runs the first sweep ~30s after start(), then hourly', async () => {
      vi.useFakeTimers();
      getSettingAsyncMock.mockResolvedValue('7');

      coverageRetentionService.start();

      await vi.advanceTimersByTimeAsync(29_000);
      expect(purgeOlderThanMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2_000);
      expect(purgeOlderThanMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(purgeOlderThanMock).toHaveBeenCalledTimes(2);
    });

    it('start() is idempotent — a second call does not double the timers', async () => {
      vi.useFakeTimers();
      getSettingAsyncMock.mockResolvedValue('7');

      coverageRetentionService.start();
      coverageRetentionService.start();

      await vi.advanceTimersByTimeAsync(31_000);
      expect(purgeOlderThanMock).toHaveBeenCalledTimes(1);
    });

    it('stop() cancels the pending and interval timers', async () => {
      vi.useFakeTimers();
      getSettingAsyncMock.mockResolvedValue('7');

      coverageRetentionService.start();
      coverageRetentionService.stop();

      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
      expect(purgeOlderThanMock).not.toHaveBeenCalled();
    });

    it('a restart (stop then start) does not reset any last-fire state — the sweep is purely cutoff-based', async () => {
      vi.useFakeTimers();
      const fixedNow = new Date('2026-01-10T00:00:00.000Z');
      vi.setSystemTime(fixedNow);
      getSettingAsyncMock.mockResolvedValue('7');

      coverageRetentionService.start();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(purgeOlderThanMock).toHaveBeenCalledTimes(1);
      const firstCutoff = purgeOlderThanMock.mock.calls[0][0];

      // Reset the wall clock back to the SAME instant before restarting —
      // isolates "does a restart re-derive the identical cutoff at the same
      // wall time" from the unrelated fact that time also passed.
      vi.setSystemTime(fixedNow);
      coverageRetentionService.stop();
      coverageRetentionService.start();
      await vi.advanceTimersByTimeAsync(30_000);

      expect(purgeOlderThanMock).toHaveBeenCalledTimes(2);
      const secondCutoff = purgeOlderThanMock.mock.calls[1][0];
      // Same system time in both sweeps ⇒ identical cutoff — no persisted
      // "time since last fire" that a restart could reset or double-fire.
      expect(secondCutoff).toBe(firstCutoff);
    });
  });
});
