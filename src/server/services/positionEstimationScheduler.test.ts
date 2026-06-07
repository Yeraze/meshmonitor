/**
 * Tests for positionEstimationScheduler (issue #3271).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockDb = vi.hoisted(() => ({
  settings: { getSetting: vi.fn(), setSetting: vi.fn() },
}));
vi.mock('../../services/database.js', () => ({ default: mockDb }));

const mockService = vi.hoisted(() => ({
  positionEstimationService: { recomputeAll: vi.fn() },
}));
vi.mock('./positionEstimationService.js', () => mockService);

import {
  isRunDue,
  positionEstimationScheduler,
  DEFAULT_FREQUENCY_HOURS,
} from './positionEstimationScheduler.js';

const HOUR = 60 * 60 * 1000;

describe('isRunDue', () => {
  it('is due when never run', () => {
    expect(isRunDue(null, 6, 1000)).toBe(true);
  });

  it('is not due before the frequency interval elapses', () => {
    const now = 100 * HOUR;
    expect(isRunDue(now - 5 * HOUR, 6, now)).toBe(false);
  });

  it('is due once the frequency interval has elapsed', () => {
    const now = 100 * HOUR;
    expect(isRunDue(now - 6 * HOUR, 6, now)).toBe(true);
  });
});

describe('positionEstimationScheduler.runNow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset singleton state between tests.
    (positionEstimationScheduler as any).lastRunTime = null;
    (positionEstimationScheduler as any).lastRunResult = null;
    mockService.positionEstimationService.recomputeAll.mockResolvedValue({
      estimatedNodeCount: 3, observationCount: 10, anchorCount: 5, durationMs: 1,
    });
    mockDb.settings.getSetting.mockResolvedValue(null);
    mockDb.settings.setSetting.mockResolvedValue(undefined);
  });

  it('invokes recomputeAll with the configured lookback window', async () => {
    mockDb.settings.getSetting.mockImplementation(async (key: string) => {
      if (key === 'position_estimation_lookback_hours') return '48';
      return null;
    });
    await positionEstimationScheduler.runNow();
    expect(mockService.positionEstimationService.recomputeAll).toHaveBeenCalledWith({
      lookbackMs: 48 * HOUR,
    });
  });

  it('records the last-run timestamp after a run', async () => {
    await positionEstimationScheduler.runNow();
    const keys = mockDb.settings.setSetting.mock.calls.map((c: any[]) => c[0]);
    expect(keys).toContain('position_estimation_last_run');
  });

  it('rejects overlapping runs', async () => {
    let release: () => void;
    mockService.positionEstimationService.recomputeAll.mockReturnValue(
      new Promise((resolve) => { release = () => resolve({ estimatedNodeCount: 0, observationCount: 0, anchorCount: 0, durationMs: 0 }); })
    );
    const first = positionEstimationScheduler.runNow();
    await expect(positionEstimationScheduler.runNow()).rejects.toThrow(/in progress/);
    release!();
    await first;
  });
});

describe('positionEstimationScheduler tick (checkAndRun via start)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Reset singleton state between tests.
    (positionEstimationScheduler as any).lastRunTime = null;
    (positionEstimationScheduler as any).lastRunResult = null;
    mockService.positionEstimationService.recomputeAll.mockResolvedValue({
      estimatedNodeCount: 0, observationCount: 0, anchorCount: 0, durationMs: 0,
    });
    mockDb.settings.setSetting.mockResolvedValue(undefined);
  });

  afterEach(() => {
    positionEstimationScheduler.stop();
    vi.useRealTimers();
  });

  it('does not run when disabled', async () => {
    mockDb.settings.getSetting.mockImplementation(async (key: string) => {
      if (key === 'position_estimation_enabled') return 'false';
      return null;
    });
    positionEstimationScheduler.start();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(mockService.positionEstimationService.recomputeAll).not.toHaveBeenCalled();
  });

  it('runs on first tick when enabled and never run before', async () => {
    mockDb.settings.getSetting.mockResolvedValue(null); // enabled (default), no last run
    positionEstimationScheduler.start();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(mockService.positionEstimationService.recomputeAll).toHaveBeenCalledTimes(1);
  });
});

describe('defaults', () => {
  it('uses a 6-hour default frequency', () => {
    expect(DEFAULT_FREQUENCY_HOURS).toBe(6);
  });
});
