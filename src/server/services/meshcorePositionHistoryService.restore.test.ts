/**
 * #6354: the post-boot MeshCore position-history sweep is skipped on a boot
 * that restored a backup; `runCleanup()` (the hourly sweep) still purges.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { getSettingAsyncMock, deleteOlderMock } = vi.hoisted(() => ({
  getSettingAsyncMock: vi.fn(),
  deleteOlderMock: vi.fn(),
}));

vi.mock('../../services/database.js', () => ({
  default: {
    getSettingAsync: getSettingAsyncMock,
    meshcore: { deletePositionHistoryOlderThan: deleteOlderMock },
  },
}));

import meshcorePositionHistoryService from './meshcorePositionHistoryService.js';
import {
  markRestoreCheckStarted,
  markRestoreCheckFinished,
  markRestoredThisBoot,
  resetRestoreBootStateForTests,
} from './restoreBootState.js';

describe('meshcorePositionHistoryService startup sweep (#6354)', () => {
  beforeEach(() => {
    resetRestoreBootStateForTests();
    getSettingAsyncMock.mockResolvedValue('7');
    deleteOlderMock.mockReset();
    deleteOlderMock.mockResolvedValue(0);
  });

  afterEach(() => {
    resetRestoreBootStateForTests();
    meshcorePositionHistoryService.stop();
  });

  it('purges on a normal boot', async () => {
    await meshcorePositionHistoryService.runStartupCleanup();
    expect(deleteOlderMock).toHaveBeenCalledTimes(1);
  });

  it('skips on a restore boot; the hourly sweep still purges', async () => {
    markRestoreCheckStarted();
    markRestoredThisBoot();
    markRestoreCheckFinished();
    await meshcorePositionHistoryService.runStartupCleanup();
    expect(deleteOlderMock).not.toHaveBeenCalled();

    await meshcorePositionHistoryService.runCleanup();
    expect(deleteOlderMock).toHaveBeenCalledTimes(1);
  });
});
