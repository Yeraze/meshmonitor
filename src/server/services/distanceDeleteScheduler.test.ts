/**
 * Tests for the per-source auto-delete-by-distance scheduler (issue #3901).
 *
 * The scheduler reads a SINGLE source's enabled/interval settings via
 * getSettingForSource and drives autoDeleteByDistanceService.runDeleteCycle
 * with that source's id — never a global all-sources scan.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getSettingForSource = vi.fn();

vi.mock('../../services/database.js', () => ({
  default: {
    settings: {
      getSettingForSource: (...args: unknown[]) => getSettingForSource(...args),
    },
  },
}));

import { DistanceDeleteScheduler } from './distanceDeleteScheduler.js';
import { autoDeleteByDistanceService } from './autoDeleteByDistanceService.js';

const HOUR_MS = 60 * 60 * 1000;

describe('DistanceDeleteScheduler (#3901)', () => {
  let runSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    getSettingForSource.mockReset();
    runSpy = vi.spyOn(autoDeleteByDistanceService, 'runDeleteCycle').mockResolvedValue({ deletedCount: 0 });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    runSpy.mockRestore();
  });

  function settings(map: Record<string, string | null>) {
    getSettingForSource.mockImplementation((sourceId: string, key: string) =>
      Promise.resolve(map[key] ?? null));
  }

  it('schedules delete cycles scoped to its own sourceId when enabled', async () => {
    settings({ autoDeleteByDistanceEnabled: 'true', autoDeleteByDistanceIntervalHours: '6' });
    const scheduler = new DistanceDeleteScheduler('source-A');

    await scheduler.start();
    expect(scheduler.running).toBe(true);
    // Reads the per-source key, not the global one.
    expect(getSettingForSource).toHaveBeenCalledWith('source-A', 'autoDeleteByDistanceEnabled');
    // Nothing runs until the 2-minute initial delay elapses.
    expect(runSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(runSpy).toHaveBeenCalledWith('source-A');

    runSpy.mockClear();
    await vi.advanceTimersByTimeAsync(6 * HOUR_MS);
    expect(runSpy).toHaveBeenCalledWith('source-A');
    expect(runSpy).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });

  it('does not schedule anything when the source has the feature disabled', async () => {
    settings({ autoDeleteByDistanceEnabled: 'false' });
    const scheduler = new DistanceDeleteScheduler('source-B');

    await scheduler.start();
    expect(scheduler.running).toBe(false);

    await vi.advanceTimersByTimeAsync(48 * HOUR_MS);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('defaults to a 24h interval when none is configured', async () => {
    settings({ autoDeleteByDistanceEnabled: 'true' }); // no interval key
    const scheduler = new DistanceDeleteScheduler('source-C');

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(120_000);
    runSpy.mockClear();

    // No cycle before 24h…
    await vi.advanceTimersByTimeAsync(23 * HOUR_MS);
    expect(runSpy).not.toHaveBeenCalled();
    // …one at 24h.
    await vi.advanceTimersByTimeAsync(1 * HOUR_MS);
    expect(runSpy).toHaveBeenCalledWith('source-C');

    scheduler.stop();
  });

  it('stop() halts further cycles', async () => {
    settings({ autoDeleteByDistanceEnabled: 'true', autoDeleteByDistanceIntervalHours: '1' });
    const scheduler = new DistanceDeleteScheduler('source-D');

    await scheduler.start();
    scheduler.stop();
    expect(scheduler.running).toBe(false);

    await vi.advanceTimersByTimeAsync(5 * HOUR_MS);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('restart via start() clears the previous timer (no double-scheduling)', async () => {
    settings({ autoDeleteByDistanceEnabled: 'true', autoDeleteByDistanceIntervalHours: '1' });
    const scheduler = new DistanceDeleteScheduler('source-E');

    await scheduler.start();
    await scheduler.start(); // restart
    await vi.advanceTimersByTimeAsync(120_000);
    await vi.advanceTimersByTimeAsync(1 * HOUR_MS);

    // Only one live interval, so exactly one cycle per interval tick.
    expect(runSpy).toHaveBeenCalledTimes(2); // initial + one interval
    expect(runSpy).toHaveBeenCalledWith('source-E');

    scheduler.stop();
  });
});
