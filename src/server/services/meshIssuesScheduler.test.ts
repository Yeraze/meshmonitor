/**
 * Tests for meshIssuesScheduler (#4964, Phase 1 WP3).
 *
 * Modeled on positionEstimationScheduler.test.ts. In addition to that file's
 * shape, this suite proves the WP3 hard-acceptance restart-safety claim:
 * `getStatus()` (which reads `getLastRun()` internally) with an EMPTY
 * in-memory cache reads `mesh_issues_last_run` from settings, and a rejected
 * `runAnalysis()` still writes that key.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockDb = vi.hoisted(() => ({
  settings: { getSetting: vi.fn(), setSetting: vi.fn() },
}));
vi.mock('../../services/database.js', () => ({ default: mockDb }));

const mockService = vi.hoisted(() => ({
  meshIssuesAnalysisService: { runAnalysis: vi.fn() },
}));
vi.mock('./meshIssuesAnalysisService.js', () => mockService);

import {
  isRunDue,
  clampLookbackHours,
  clampPairBucketHours,
  clampFrequencyHours,
  meshIssuesScheduler,
  DEFAULT_FREQUENCY_HOURS,
  DEFAULT_LOOKBACK_HOURS,
  DEFAULT_PAIR_BUCKET_HOURS,
} from './meshIssuesScheduler.js';

const HOUR = 60 * 60 * 1000;

function resetSchedulerState() {
  (meshIssuesScheduler as any).lastRunTime = null;
  (meshIssuesScheduler as any).lastRunResult = null;
  (meshIssuesScheduler as any).inProgress = false;
  (meshIssuesScheduler as any).runLock = null;
}

describe('isRunDue', () => {
  it('is due when never run (null last-run)', () => {
    expect(isRunDue(null, 24, 1000)).toBe(true);
  });

  it('is not due just under the frequency interval', () => {
    const now = 100 * HOUR;
    expect(isRunDue(now - (24 * HOUR - 1), 24, now)).toBe(false);
  });

  it('is due exactly at the frequency interval', () => {
    const now = 100 * HOUR;
    expect(isRunDue(now - 24 * HOUR, 24, now)).toBe(true);
  });

  it('is due just over the frequency interval', () => {
    const now = 100 * HOUR;
    expect(isRunDue(now - (24 * HOUR + 1), 24, now)).toBe(true);
  });
});

describe('clampLookbackHours', () => {
  it('clamps a too-small value UP to the minimum (24)', () => {
    expect(clampLookbackHours(10)).toBe(24);
  });

  it('clamps a too-large value DOWN to the maximum (720)', () => {
    expect(clampLookbackHours(900)).toBe(720);
  });

  it('falls back to the default (168) for unparseable input', () => {
    expect(clampLookbackHours('abc')).toBe(168);
    expect(clampLookbackHours(DEFAULT_LOOKBACK_HOURS)).toBe(168);
  });

  it('passes a valid in-range value through unchanged', () => {
    expect(clampLookbackHours(200)).toBe(200);
  });
});

describe('clampPairBucketHours', () => {
  it('clamps a too-small value UP to the minimum (1)', () => {
    expect(clampPairBucketHours(0)).toBe(1);
  });

  it('clamps a too-large value DOWN to the maximum (24)', () => {
    expect(clampPairBucketHours(99)).toBe(24);
  });

  it('falls back to the default (6) for unparseable input', () => {
    expect(clampPairBucketHours('abc')).toBe(DEFAULT_PAIR_BUCKET_HOURS);
  });
});

describe('clampFrequencyHours', () => {
  it('falls back to the default (24) below the minimum, not the minimum itself', () => {
    expect(clampFrequencyHours(0.1)).toBe(24);
    expect(DEFAULT_FREQUENCY_HOURS).toBe(24);
  });

  it('falls back to the default for unparseable input', () => {
    expect(clampFrequencyHours('abc')).toBe(DEFAULT_FREQUENCY_HOURS);
  });

  it('has no upper bound', () => {
    expect(clampFrequencyHours(10_000)).toBe(10_000);
  });
});

describe('meshIssuesScheduler.runNow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSchedulerState();
    mockService.meshIssuesAnalysisService.runAnalysis.mockResolvedValue({
      durationMs: 1,
      sourceCount: 1,
      nodeCount: 0,
      findingCount: 0,
      newCount: 0,
      reopenedCount: 0,
      updatedCount: 0,
      closedCount: 0,
      byType: {},
      corpusStats: {
        rawCount: 0, validCount: 0, dedupedCount: 0, sampledCount: 0,
        distinctPairCount: 0, truncated: false,
      },
    });
    mockDb.settings.getSetting.mockResolvedValue(null);
    mockDb.settings.setSetting.mockResolvedValue(undefined);
  });

  it('invokes runAnalysis with the configured lookback and pair-bucket windows', async () => {
    mockDb.settings.getSetting.mockImplementation(async (key: string) => {
      if (key === 'mesh_issues_lookback_hours') return '48';
      if (key === 'mesh_issues_pair_bucket_hours') return '12';
      return null;
    });
    await meshIssuesScheduler.runNow();
    expect(mockService.meshIssuesAnalysisService.runAnalysis).toHaveBeenCalledWith({
      lookbackHours: 48,
      pairBucketHours: 12,
    });
  });

  it('defaults to DEFAULT_LOOKBACK_HOURS / DEFAULT_PAIR_BUCKET_HOURS when unset', async () => {
    await meshIssuesScheduler.runNow();
    expect(mockService.meshIssuesAnalysisService.runAnalysis).toHaveBeenCalledWith({
      lookbackHours: DEFAULT_LOOKBACK_HOURS,
      pairBucketHours: DEFAULT_PAIR_BUCKET_HOURS,
    });
  });

  it('records the last-run timestamp in settings after a successful run', async () => {
    await meshIssuesScheduler.runNow();
    const keys = mockDb.settings.setSetting.mock.calls.map((c: any[]) => c[0]);
    expect(keys).toContain('mesh_issues_last_run');
  });

  it('rejects overlapping runs with an "in progress" error', async () => {
    let release: () => void;
    mockService.meshIssuesAnalysisService.runAnalysis.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({
          durationMs: 0, sourceCount: 0, nodeCount: 0, findingCount: 0,
          newCount: 0, reopenedCount: 0, updatedCount: 0, closedCount: 0,
          byType: {}, corpusStats: {
            rawCount: 0, validCount: 0, dedupedCount: 0, sampledCount: 0,
            distinctPairCount: 0, truncated: false,
          },
        });
      })
    );
    const first = meshIssuesScheduler.runNow();
    await expect(meshIssuesScheduler.runNow()).rejects.toThrow(/in progress/);
    release!();
    await first;
  });

  it('still writes mesh_issues_last_run when runAnalysis rejects (no retry storm)', async () => {
    mockService.meshIssuesAnalysisService.runAnalysis.mockRejectedValueOnce(new Error('boom'));
    await expect(meshIssuesScheduler.runNow()).rejects.toThrow('boom');
    const keys = mockDb.settings.setSetting.mock.calls.map((c: any[]) => c[0]);
    expect(keys).toContain('mesh_issues_last_run');
  });

  it('writes mesh_issues_last_run_summary on a successful run', async () => {
    await meshIssuesScheduler.runNow();
    const calls = mockDb.settings.setSetting.mock.calls as any[];
    const summaryCall = calls.find((c) => c[0] === 'mesh_issues_last_run_summary');
    expect(summaryCall).toBeDefined();
    const parsed = JSON.parse(summaryCall[1]);
    expect(typeof parsed.at).toBe('number');
    expect(parsed.result.durationMs).toBe(1);
  });

  it('does NOT write mesh_issues_last_run_summary when runAnalysis rejects', async () => {
    mockService.meshIssuesAnalysisService.runAnalysis.mockRejectedValueOnce(new Error('boom'));
    await expect(meshIssuesScheduler.runNow()).rejects.toThrow('boom');
    const keys = mockDb.settings.setSetting.mock.calls.map((c: any[]) => c[0]);
    expect(keys).not.toContain('mesh_issues_last_run_summary');
  });

  it('runLock is cleared after a rejected run, allowing a subsequent run', async () => {
    mockService.meshIssuesAnalysisService.runAnalysis.mockRejectedValueOnce(new Error('boom'));
    await expect(meshIssuesScheduler.runNow()).rejects.toThrow('boom');
    mockService.meshIssuesAnalysisService.runAnalysis.mockResolvedValueOnce({
      durationMs: 1, sourceCount: 1, nodeCount: 0, findingCount: 0,
      newCount: 0, reopenedCount: 0, updatedCount: 0, closedCount: 0,
      byType: {}, corpusStats: {
        rawCount: 0, validCount: 0, dedupedCount: 0, sampledCount: 0,
        distinctPairCount: 0, truncated: false,
      },
    });
    await expect(meshIssuesScheduler.runNow()).resolves.toBeDefined();
  });
});

describe('meshIssuesScheduler restart safety (getStatus / getLastRun)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSchedulerState();
    mockDb.settings.setSetting.mockResolvedValue(undefined);
  });

  it('with an empty in-memory cache, reads mesh_issues_last_run from settings', async () => {
    mockDb.settings.getSetting.mockImplementation(async (key: string) => {
      if (key === 'mesh_issues_last_run') return '123456789';
      return null;
    });
    const status = await meshIssuesScheduler.getStatus();
    expect(status.lastRunTime).toBe(123456789);
  });

  it('returns null when nothing has ever run and no settings row exists', async () => {
    mockDb.settings.getSetting.mockResolvedValue(null);
    const status = await meshIssuesScheduler.getStatus();
    expect(status.lastRunTime).toBeNull();
  });

  it('prefers the in-memory cache over settings once a run has happened this process', async () => {
    mockService.meshIssuesAnalysisService.runAnalysis.mockResolvedValue({
      durationMs: 1, sourceCount: 1, nodeCount: 0, findingCount: 0,
      newCount: 0, reopenedCount: 0, updatedCount: 0, closedCount: 0,
      byType: {}, corpusStats: {
        rawCount: 0, validCount: 0, dedupedCount: 0, sampledCount: 0,
        distinctPairCount: 0, truncated: false,
      },
    });
    mockDb.settings.getSetting.mockResolvedValue(null);
    await meshIssuesScheduler.runNow();
    mockDb.settings.getSetting.mockClear();
    const status = await meshIssuesScheduler.getStatus();
    expect(status.lastRunTime).not.toBeNull();
    // getLastRun short-circuits on the in-memory cache and never re-reads the key.
    const readKeys = mockDb.settings.getSetting.mock.calls.map((c: any[]) => c[0]);
    expect(readKeys).not.toContain('mesh_issues_last_run');
  });
});

describe('meshIssuesScheduler restart safety (lastRunResult recovery, #4964 Phase 3 WP1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSchedulerState();
    mockDb.settings.setSetting.mockResolvedValue(undefined);
  });

  it('with an empty in-memory lastRunResult, recovers it from mesh_issues_last_run_summary and sets lastRunResultFromStorage', async () => {
    const storedResult = {
      durationMs: 42, sourceCount: 1, nodeCount: 5, findingCount: 3,
      newCount: 1, reopenedCount: 0, updatedCount: 2, closedCount: 0,
      byType: { A1_deprecated_role: 3 },
      corpusStats: { rawCount: 0, validCount: 0, dedupedCount: 0, sampledCount: 0, distinctPairCount: 0, truncated: false },
    };
    mockDb.settings.getSetting.mockImplementation(async (key: string) => {
      if (key === 'mesh_issues_last_run_summary') {
        return JSON.stringify({ at: 123, result: storedResult });
      }
      return null;
    });

    const status = await meshIssuesScheduler.getStatus();

    expect(status.lastRunResult).toEqual(storedResult);
    expect(status.lastRunResultFromStorage).toBe(true);
  });

  it('prefers the in-memory lastRunResult over storage, and reports lastRunResultFromStorage: false', async () => {
    mockService.meshIssuesAnalysisService.runAnalysis.mockResolvedValue({
      durationMs: 1, sourceCount: 1, nodeCount: 0, findingCount: 0,
      newCount: 0, reopenedCount: 0, updatedCount: 0, closedCount: 0,
      byType: {}, corpusStats: {
        rawCount: 0, validCount: 0, dedupedCount: 0, sampledCount: 0,
        distinctPairCount: 0, truncated: false,
      },
    });
    mockDb.settings.getSetting.mockResolvedValue(null);
    await meshIssuesScheduler.runNow();

    const status = await meshIssuesScheduler.getStatus();
    expect(status.lastRunResultFromStorage).toBe(false);
    expect(status.lastRunResult).not.toBeNull();
  });

  it('malformed JSON in mesh_issues_last_run_summary degrades to lastRunResult: null without throwing', async () => {
    mockDb.settings.getSetting.mockImplementation(async (key: string) => {
      if (key === 'mesh_issues_last_run_summary') return '{not valid json';
      return null;
    });

    const status = await meshIssuesScheduler.getStatus();

    expect(status.lastRunResult).toBeNull();
    expect(status.lastRunResultFromStorage).toBe(false);
  });

  it('a well-formed-JSON-but-wrong-shape value (e.g. an array, or missing durationMs) degrades to null', async () => {
    mockDb.settings.getSetting.mockImplementation(async (key: string) => {
      if (key === 'mesh_issues_last_run_summary') return JSON.stringify([1, 2, 3]);
      return null;
    });
    const status1 = await meshIssuesScheduler.getStatus();
    expect(status1.lastRunResult).toBeNull();

    mockDb.settings.getSetting.mockImplementation(async (key: string) => {
      if (key === 'mesh_issues_last_run_summary') return JSON.stringify({ at: 1, result: { findingCount: 1 } });
      return null;
    });
    const status2 = await meshIssuesScheduler.getStatus();
    expect(status2.lastRunResult).toBeNull();
  });

  it('getStatus() returns resolved + clamped thresholds', async () => {
    mockDb.settings.getSetting.mockImplementation(async (key: string) => {
      if (key === 'mesh_issues_air_util_tx_pct') return '9999'; // out of range, clamps to 50
      if (key === 'mesh_issues_tier_c_enabled') return 'false';
      return null;
    });

    const status = await meshIssuesScheduler.getStatus();

    expect(status.thresholds.airUtilTxPct).toBe(50);
    expect(status.thresholds.tierCEnabled).toBe(false);
    expect(status.thresholds.tierAEnabled).toBe(true);
  });
});

describe('meshIssuesScheduler.getStatus enabled default', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSchedulerState();
  });

  it('defaults enabled to true when the setting is unset (null)', async () => {
    mockDb.settings.getSetting.mockResolvedValue(null);
    const status = await meshIssuesScheduler.getStatus();
    expect(status.enabled).toBe(true);
  });

  it('stays enabled when explicitly set to "true"', async () => {
    mockDb.settings.getSetting.mockImplementation(async (key: string) => {
      if (key === 'mesh_issues_enabled') return 'true';
      return null;
    });
    const status = await meshIssuesScheduler.getStatus();
    expect(status.enabled).toBe(true);
  });

  it('is disabled only when explicitly set to "false"', async () => {
    mockDb.settings.getSetting.mockImplementation(async (key: string) => {
      if (key === 'mesh_issues_enabled') return 'false';
      return null;
    });
    const status = await meshIssuesScheduler.getStatus();
    expect(status.enabled).toBe(false);
  });
});

describe('meshIssuesScheduler tick (checkAndRun via start)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    resetSchedulerState();
    mockService.meshIssuesAnalysisService.runAnalysis.mockResolvedValue({
      durationMs: 0, sourceCount: 0, nodeCount: 0, findingCount: 0,
      newCount: 0, reopenedCount: 0, updatedCount: 0, closedCount: 0,
      byType: {}, corpusStats: {
        rawCount: 0, validCount: 0, dedupedCount: 0, sampledCount: 0,
        distinctPairCount: 0, truncated: false,
      },
    });
    mockDb.settings.setSetting.mockResolvedValue(undefined);
  });

  afterEach(() => {
    meshIssuesScheduler.stop();
    vi.useRealTimers();
  });

  it('does not run when disabled', async () => {
    mockDb.settings.getSetting.mockImplementation(async (key: string) => {
      if (key === 'mesh_issues_enabled') return 'false';
      return null;
    });
    meshIssuesScheduler.start();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(mockService.meshIssuesAnalysisService.runAnalysis).not.toHaveBeenCalled();
  });

  it('runs on first tick when enabled and never run before', async () => {
    mockDb.settings.getSetting.mockResolvedValue(null); // enabled (default), no last run
    meshIssuesScheduler.start();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(mockService.meshIssuesAnalysisService.runAnalysis).toHaveBeenCalledTimes(1);
  });

  it('does not double-start a second interval', async () => {
    mockDb.settings.getSetting.mockResolvedValue(null);
    meshIssuesScheduler.start();
    meshIssuesScheduler.start();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(mockService.meshIssuesAnalysisService.runAnalysis).toHaveBeenCalledTimes(1);
  });
});

describe('defaults', () => {
  it('uses a 24-hour default frequency', () => {
    expect(DEFAULT_FREQUENCY_HOURS).toBe(24);
  });

  it('uses a 168-hour (7-day) default lookback', () => {
    expect(DEFAULT_LOOKBACK_HOURS).toBe(168);
  });

  it('uses a 6-hour default pair-bucket window', () => {
    expect(DEFAULT_PAIR_BUCKET_HOURS).toBe(6);
  });
});
