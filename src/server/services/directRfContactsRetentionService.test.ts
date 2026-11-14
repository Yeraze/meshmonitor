/**
 * Direct RF Contacts retention sweep (#6210). The service must not start a
 * timer on import, so every test calls start()/stop() itself.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { getSettingAsyncMock, purgeOlderThanMock } = vi.hoisted(() => ({
  getSettingAsyncMock: vi.fn(),
  purgeOlderThanMock: vi.fn(),
}));

vi.mock('../../services/database.js', () => {
  const shared = {
    getSettingAsync: getSettingAsyncMock,
    directRfContacts: { purgeOlderThan: purgeOlderThanMock },
  };
  return { default: shared, databaseService: shared };
});

import { directRfContactsRetentionService } from './directRfContactsRetentionService.js';
import { clampDirectRfRetentionDays } from '../../utils/directRfContacts.js';
import {
  markRestoreCheckStarted,
  markRestoreCheckFinished,
  markRestoredThisBoot,
  resetRestoreBootStateForTests,
} from './restoreBootState.js';

const DAY = 86_400_000;

describe('clampDirectRfRetentionDays', () => {
  it('defaults to 30 and clamps to 1-365', () => {
    expect(clampDirectRfRetentionDays(null)).toBe(30);
    expect(clampDirectRfRetentionDays(undefined)).toBe(30);
    expect(clampDirectRfRetentionDays('')).toBe(30);
    expect(clampDirectRfRetentionDays('junk')).toBe(30);
    expect(clampDirectRfRetentionDays('0')).toBe(1);
    expect(clampDirectRfRetentionDays('9999')).toBe(365);
    expect(clampDirectRfRetentionDays('14.7')).toBe(14);
  });
});

describe('directRfContactsRetentionService', () => {
  beforeEach(() => {
    getSettingAsyncMock.mockReset();
    purgeOlderThanMock.mockReset();
    purgeOlderThanMock.mockResolvedValue(0);
  });
  afterEach(() => {
    directRfContactsRetentionService.stop();
    vi.useRealTimers();
  });

  it('purges day rows before floor(now - retention days)', async () => {
    getSettingAsyncMock.mockResolvedValue('10');
    const now = 100 * DAY + 5 * 3_600_000;
    purgeOlderThanMock.mockResolvedValue(4);
    await expect(directRfContactsRetentionService.runCleanup(now)).resolves.toBe(4);
    expect(getSettingAsyncMock).toHaveBeenCalledWith('direct_rf_contacts_retention_days');
    expect(purgeOlderThanMock).toHaveBeenCalledWith(90 * DAY);
  });

  it('uses the 30-day default when the setting is unset', async () => {
    getSettingAsyncMock.mockResolvedValue(null);
    await directRfContactsRetentionService.runCleanup(100 * DAY);
    expect(purgeOlderThanMock).toHaveBeenCalledWith(70 * DAY);
  });

  it('never throws when the purge fails', async () => {
    getSettingAsyncMock.mockResolvedValue('30');
    purgeOlderThanMock.mockRejectedValue(new Error('db down'));
    await expect(directRfContactsRetentionService.runCleanup()).resolves.toBe(0);
  });

  it('starts no timer until start(); first sweep after 30 s, then hourly', async () => {
    vi.useFakeTimers();
    getSettingAsyncMock.mockResolvedValue('30');
    directRfContactsRetentionService.start();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(purgeOlderThanMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(purgeOlderThanMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(purgeOlderThanMock).toHaveBeenCalledTimes(2);
  });

  it('skips the startup sweep on a boot that restored a backup', async () => {
    markRestoreCheckStarted();
    markRestoredThisBoot();
    markRestoreCheckFinished();
    try {
      getSettingAsyncMock.mockResolvedValue('30');
      await directRfContactsRetentionService.runStartupCleanup();
      expect(purgeOlderThanMock).not.toHaveBeenCalled();
    } finally {
      resetRestoreBootStateForTests();
    }
  });
});
