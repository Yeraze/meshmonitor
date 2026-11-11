/**
 * #6354: on the boot that restores a backup, startup retention purges skip
 * their first run and warn; on any other boot they run.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '../../utils/logger.js';
import {
  markRestoreCheckStarted,
  markRestoreCheckFinished,
  markRestoredThisBoot,
  skipStartupPurgeAfterRestore,
  wasRestoredThisBoot,
  resetRestoreBootStateForTests,
} from './restoreBootState.js';

describe('restoreBootState (#6354)', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetRestoreBootStateForTests();
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    resetRestoreBootStateForTests();
  });

  it('does not skip when no restore check ever started (tests, tools)', async () => {
    await expect(skipStartupPurgeAfterRestore('telemetry', '168h', 'in about 1 hour')).resolves.toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not skip on a normal boot (check finished, nothing restored)', async () => {
    markRestoreCheckStarted();
    markRestoreCheckFinished();
    await expect(skipStartupPurgeAfterRestore('telemetry', '168h', 'in about 1 hour')).resolves.toBe(false);
    expect(wasRestoredThisBoot()).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('skips and warns with the retention window on a restore boot', async () => {
    markRestoreCheckStarted();
    markRestoredThisBoot();
    markRestoreCheckFinished();
    await expect(skipStartupPurgeAfterRestore('telemetry', '168h', 'in about 1 hour')).resolves.toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toContain('telemetry');
    expect(msg).toContain('168h');
    expect(msg).toContain('next scheduled purge');
  });

  it('waits for a restore still in progress before deciding', async () => {
    markRestoreCheckStarted();
    let decided: boolean | undefined;
    const pending = skipStartupPurgeAfterRestore('telemetry', '168h', 'in about 1 hour').then((v) => {
      decided = v;
    });
    await Promise.resolve();
    expect(decided).toBeUndefined();

    markRestoredThisBoot();
    markRestoreCheckFinished();
    await pending;
    expect(decided).toBe(true);
  });
});
