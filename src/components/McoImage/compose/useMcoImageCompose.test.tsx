/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { AutoFitPlan, AutoFitWinner } from '../../../utils/mcoImage/compose/autoFit.js';
import type { CandidateResult, RgbaImage } from '../../../utils/mcoImage/compose/types.js';
import { PoolCancelledError, type McoEncodePool, type PoolJob } from './mcoEncodePool.js';
import { useMcoImageCompose, type ManualSettings } from './useMcoImageCompose.js';

vi.mock('../../../utils/mcoImage/compose/quantize.js', () => ({ isNearGray: () => false }));

interface Pending {
  gen: number;
  job: PoolJob;
  resolve(r: CandidateResult): void;
  reject(e: Error): void;
}

function fakePool() {
  const runs: Pending[] = [];
  const pool = {
    setSource: vi.fn(),
    run: vi.fn((gen: number, job: PoolJob) => new Promise<CandidateResult>((resolve, reject) => runs.push({ gen, job, resolve, reject }))),
    cancelJob: vi.fn((jobId: number) => {
      runs.find((r) => r.job.jobId === jobId)?.reject(new PoolCancelledError());
    }),
    cancelGeneration: vi.fn(),
    dispose: vi.fn(),
  };
  return { pool: pool as unknown as McoEncodePool & typeof pool, runs };
}

const src: RgbaImage = { width: 64, height: 32, rgba: new Uint8ClampedArray(64 * 32 * 4) };
const manual: ManualSettings = { size: 32, profile: 2, dither: false };
const res = (level: 'normal' | 'high', im3Bytes: number, im4Bytes = im3Bytes + 6): CandidateResult => ({
  w: 32,
  h: 16,
  profile: 2,
  dither: false,
  level,
  im3Text: `im3:${level}${im3Bytes}`,
  im4Text: `im4:${level}${im4Bytes}`,
  im3Bytes,
  im4Bytes,
  ms: 1,
});

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe('useMcoImageCompose', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('manual: debounces, shows Normal at once, High keeps the shorter text', async () => {
    const { pool, runs } = fakePool();
    const { result } = renderHook(() =>
      useMcoImageCompose({ source: src, limit: 100, mode: 'manual', manual, enabled: true, poolFactory: () => pool }),
    );
    expect(pool.run).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(249); });
    expect(pool.run).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(runs[0].job.level).toBe('normal');
    runs[0].resolve(res('normal', 80));
    await flush();
    expect(result.current.im3).toMatchObject({ status: 'optimizing', text: 'im3:normal80', fits: true });
    expect(runs[1].job.level).toBe('high');
    runs[1].resolve(res('high', 81, 85)); // High longer for IM3, shorter for IM4
    await flush();
    expect(result.current.im3).toMatchObject({ status: 'ready', text: 'im3:normal80' });
    expect(result.current.im4).toMatchObject({ status: 'ready', text: 'im4:high85', bytes: 85 });
  });

  it('manual: a High timeout keeps the Normal result and flags it', async () => {
    const { pool, runs } = fakePool();
    const { result } = renderHook(() =>
      useMcoImageCompose({
        source: src, limit: 100, mode: 'manual', manual, enabled: true, poolFactory: () => pool, highTimeoutMs: 20_000,
      }),
    );
    await act(async () => { vi.advanceTimersByTime(250); });
    runs[0].resolve(res('normal', 80));
    await flush();
    await act(async () => { vi.advanceTimersByTime(20_000); });
    expect(pool.cancelJob).toHaveBeenCalledWith(runs[1].job.jobId);
    await flush();
    expect(result.current.highTimedOut).toBe(true);
    expect(result.current.im3).toMatchObject({ status: 'ready', text: 'im3:normal80' });
  });

  it('manual: marks an over-limit result as nofit', async () => {
    const { pool, runs } = fakePool();
    const { result } = renderHook(() =>
      useMcoImageCompose({ source: src, limit: 50, mode: 'manual', manual, enabled: true, poolFactory: () => pool }),
    );
    await act(async () => { vi.advanceTimersByTime(250); });
    runs[0].resolve(res('normal', 80));
    await flush();
    runs[1].resolve(res('high', 79));
    await flush();
    expect(result.current.im3).toMatchObject({ status: 'nofit', fits: false, bytes: 79 });
  });

  it('a settings change cancels the old generation and restarts', async () => {
    const { pool, runs } = fakePool();
    const { rerender } = renderHook(
      ({ m }) => useMcoImageCompose({ source: src, limit: 100, mode: 'manual', manual: m, enabled: true, poolFactory: () => pool }),
      { initialProps: { m: manual } },
    );
    await act(async () => { vi.advanceTimersByTime(250); });
    expect(runs).toHaveLength(1);
    rerender({ m: { ...manual, size: 40 } });
    expect(pool.cancelGeneration).toHaveBeenCalled();
    // a late result from the old generation is ignored
    runs[0].resolve(res('normal', 10));
    await flush();
    expect(runs).toHaveLength(1);
    await act(async () => { vi.advanceTimersByTime(250); });
    expect(runs).toHaveLength(2);
    expect(runs[1].job.candidate.longest).toBe(40);
  });

  it('auto: runs the plan jobs and publishes winners', async () => {
    const { pool, runs } = fakePool();
    const w = (bytes: number): AutoFitWinner => ({ result: res('normal', bytes), text: `im3:x${bytes}`, bytes, level: 'normal' });
    let phase: 'searching' | 'refining' | 'done' = 'searching';
    let queued = [{ jobId: 1, candidate: { longest: 32, profile: 2 as const, dither: false }, level: 'normal' as const }];
    const plan: AutoFitPlan = {
      next: () => { const q = queued; queued = []; return q; },
      accept: vi.fn(() => { phase = 'refining'; }),
      fail: vi.fn(() => { phase = 'done'; }),
      winners: () => (phase === 'searching' ? {} : { im3: w(90), im4: w(96) }),
      phase: () => phase,
    };
    const planFactory = vi.fn(() => plan);
    const { result } = renderHook(() =>
      useMcoImageCompose({ source: src, limit: 100, mode: 'auto', manual, enabled: true, poolFactory: () => pool, planFactory }),
    );
    expect(planFactory).toHaveBeenCalledWith({ srcLongest: 64, gray: false, limit: 100 });
    expect(result.current.im3.status).toBe('searching');
    runs[0].resolve(res('normal', 90));
    await flush();
    expect(plan.accept).toHaveBeenCalledWith(1, expect.anything());
    expect(result.current.im3).toMatchObject({ status: 'optimizing', fits: true });
  });

  it('disposes the pool when disabled or unmounted', () => {
    const { pool } = fakePool();
    const { unmount } = renderHook(() =>
      useMcoImageCompose({ source: src, limit: 100, mode: 'manual', manual, enabled: true, poolFactory: () => pool }),
    );
    unmount();
    expect(pool.dispose).toHaveBeenCalled();
  });
});
