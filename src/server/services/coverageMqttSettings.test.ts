/**
 * Tests for the per-source `coverage_mqtt_enabled` TTL flag cache (#5277
 * P2, §2.1 / §3). Must always read through `getSettingForSource`, never the
 * bare-key `getSettingAsync` (#5080).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { getSettingForSourceMock, getSettingAsyncMock } = vi.hoisted(() => ({
  getSettingForSourceMock: vi.fn(),
  getSettingAsyncMock: vi.fn(),
}));

vi.mock('../../services/database.js', () => ({
  default: {
    settings: {
      getSettingForSource: getSettingForSourceMock,
    },
    getSettingAsync: getSettingAsyncMock,
  },
}));

import {
  isCoverageMqttEnabled,
  invalidateCoverageMqttEnabled,
  __resetCoverageMqttCacheForTest,
} from './coverageMqttSettings.js';
import { COVERAGE_MQTT_ENABLED_SETTING } from '../../utils/coverage.js';

const SOURCE_A = 'src-a';
const SOURCE_B = 'src-b';

describe('coverageMqttSettings', () => {
  beforeEach(() => {
    getSettingForSourceMock.mockReset();
    getSettingAsyncMock.mockReset();
    __resetCoverageMqttCacheForTest();
  });

  it('defaults to false when no row exists', async () => {
    getSettingForSourceMock.mockResolvedValue(null);
    expect(await isCoverageMqttEnabled(SOURCE_A)).toBe(false);
  });

  it('reads via getSettingForSource(sourceId, key), never the bare-key getSettingAsync', async () => {
    getSettingForSourceMock.mockResolvedValue('1');
    expect(await isCoverageMqttEnabled(SOURCE_A)).toBe(true);
    expect(getSettingForSourceMock).toHaveBeenCalledWith(SOURCE_A, COVERAGE_MQTT_ENABLED_SETTING);
    expect(getSettingAsyncMock).not.toHaveBeenCalled();
  });

  it("accepts '1' and 'true', rejects anything else", async () => {
    getSettingForSourceMock.mockResolvedValueOnce('1');
    expect(await isCoverageMqttEnabled(SOURCE_A)).toBe(true);
    __resetCoverageMqttCacheForTest();

    getSettingForSourceMock.mockResolvedValueOnce('true');
    expect(await isCoverageMqttEnabled(SOURCE_A)).toBe(true);
    __resetCoverageMqttCacheForTest();

    getSettingForSourceMock.mockResolvedValueOnce('0');
    expect(await isCoverageMqttEnabled(SOURCE_A)).toBe(false);
  });

  describe('TTL caching', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
    });
    afterEach(() => vi.useRealTimers());

    it('two reads within the TTL make one DB call', async () => {
      getSettingForSourceMock.mockResolvedValue('1');
      await isCoverageMqttEnabled(SOURCE_A);
      await isCoverageMqttEnabled(SOURCE_A);
      expect(getSettingForSourceMock).toHaveBeenCalledTimes(1);
    });

    it('reloads once the TTL (30s) has expired', async () => {
      getSettingForSourceMock.mockResolvedValue('1');
      await isCoverageMqttEnabled(SOURCE_A);
      vi.setSystemTime(new Date('2024-01-01T00:00:31.000Z')); // +31s
      await isCoverageMqttEnabled(SOURCE_A);
      expect(getSettingForSourceMock).toHaveBeenCalledTimes(2);
    });
  });

  it('invalidateCoverageMqttEnabled(id) forces a re-read for that source only', async () => {
    getSettingForSourceMock.mockResolvedValue('1');
    await isCoverageMqttEnabled(SOURCE_A);
    await isCoverageMqttEnabled(SOURCE_B);
    expect(getSettingForSourceMock).toHaveBeenCalledTimes(2);

    invalidateCoverageMqttEnabled(SOURCE_A);

    await isCoverageMqttEnabled(SOURCE_A); // re-read
    await isCoverageMqttEnabled(SOURCE_B); // still cached
    expect(getSettingForSourceMock).toHaveBeenCalledTimes(3);
  });

  it('invalidateCoverageMqttEnabled() with no arg clears every source', async () => {
    getSettingForSourceMock.mockResolvedValue('1');
    await isCoverageMqttEnabled(SOURCE_A);
    await isCoverageMqttEnabled(SOURCE_B);
    expect(getSettingForSourceMock).toHaveBeenCalledTimes(2);

    invalidateCoverageMqttEnabled();

    await isCoverageMqttEnabled(SOURCE_A);
    await isCoverageMqttEnabled(SOURCE_B);
    expect(getSettingForSourceMock).toHaveBeenCalledTimes(4);
  });

  it('a read error is fail-closed (false), and is itself cached for the TTL', async () => {
    getSettingForSourceMock.mockRejectedValue(new Error('db unavailable'));
    expect(await isCoverageMqttEnabled(SOURCE_A)).toBe(false);
    expect(await isCoverageMqttEnabled(SOURCE_A)).toBe(false);
    expect(getSettingForSourceMock).toHaveBeenCalledTimes(1);
  });
});
