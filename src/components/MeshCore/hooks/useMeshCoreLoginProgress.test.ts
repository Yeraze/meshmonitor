/**
 * @vitest-environment jsdom
 *
 * useMeshCoreLoginProgress (#5400): runs a login with a fresh requestId,
 * polls its progress, and cancels it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMeshCoreLoginProgress, LOGIN_PROGRESS_POLL_MS } from './useMeshCoreLoginProgress';
import type { MeshCoreLoginProgressSnapshot } from './useMeshCore';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const snap = (over: Partial<MeshCoreLoginProgressSnapshot>): MeshCoreLoginProgressSnapshot => ({
  requestId: 'x',
  phase: 'waiting',
  attempt: 1,
  maxAttempts: 3,
  waitMs: 12_000,
  waitRemainingMs: 12_000,
  cancelRequested: false,
  outcome: null,
  ...over,
});

describe('useMeshCoreLoginProgress', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes a fresh requestId, shows polled progress, and clears when done', async () => {
    const getLoginProgress = vi.fn().mockResolvedValue(snap({ attempt: 2 }));
    const cancelLogin = vi.fn().mockResolvedValue(true);
    const { result } = renderHook(() => useMeshCoreLoginProgress({ getLoginProgress, cancelLogin }));

    const login = deferred<{ success: boolean }>();
    let seenId = '';
    let run!: Promise<{ value: { success: boolean }; cancelledByUser: boolean }>;
    act(() => {
      run = result.current.run((id) => {
        seenId = id;
        return login.promise;
      });
    });
    expect(seenId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(result.current.progress).toMatchObject({ phase: 'starting', attempt: 1 });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOGIN_PROGRESS_POLL_MS);
    });
    expect(getLoginProgress).toHaveBeenCalledWith(seenId);
    expect(result.current.progress).toMatchObject({ phase: 'waiting', attempt: 2, waitMs: 12_000 });
    expect(result.current.progress?.waitEndsAt).toBeGreaterThan(Date.now());

    await act(async () => {
      login.resolve({ success: true });
      await run;
    });
    expect(await run).toEqual({ value: { success: true }, cancelledByUser: false });
    expect(result.current.progress).toBeNull();

    // Polling stops with the login.
    getLoginProgress.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOGIN_PROGRESS_POLL_MS * 3);
    });
    expect(getLoginProgress).not.toHaveBeenCalled();
  });

  it('cancel tells the server, and a success that raced it still reads cancelled', async () => {
    const getLoginProgress = vi.fn().mockResolvedValue(snap({}));
    const cancelLogin = vi.fn().mockResolvedValue(true);
    const { result } = renderHook(() => useMeshCoreLoginProgress({ getLoginProgress, cancelLogin }));
    const login = deferred<{ success: boolean }>();
    let seenId = '';
    let run!: Promise<{ value: { success: boolean }; cancelledByUser: boolean }>;
    act(() => {
      run = result.current.run((id) => {
        seenId = id;
        return login.promise;
      });
    });

    await act(async () => {
      await result.current.cancel();
    });
    expect(cancelLogin).toHaveBeenCalledWith(seenId);
    expect(result.current.progress?.cancelling).toBe(true);

    await act(async () => {
      login.resolve({ success: true }); // late reply
      await run;
    });
    expect((await run).cancelledByUser).toBe(true);
  });

  it('re-sends a cancel pressed before the server had registered the login', async () => {
    // First cancel lands before the POST reached the server: it finds nothing.
    const cancelLogin = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const getLoginProgress = vi.fn().mockResolvedValue(snap({ cancelRequested: false }));
    const { result } = renderHook(() => useMeshCoreLoginProgress({ getLoginProgress, cancelLogin }));
    const login = deferred<{ success: boolean }>();
    let run!: Promise<unknown>;
    act(() => {
      run = result.current.run(() => login.promise);
    });
    await act(async () => {
      await result.current.cancel();
    });
    expect(cancelLogin).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOGIN_PROGRESS_POLL_MS);
    });
    expect(cancelLogin).toHaveBeenCalledTimes(2);

    await act(async () => {
      login.resolve({ success: false });
      await run;
    });
  });

  it('survives a failing progress poll', async () => {
    const getLoginProgress = vi.fn().mockRejectedValue(new Error('network'));
    const cancelLogin = vi.fn();
    const { result } = renderHook(() => useMeshCoreLoginProgress({ getLoginProgress, cancelLogin }));
    const login = deferred<string>();
    let run!: Promise<{ value: string; cancelledByUser: boolean }>;
    act(() => {
      run = result.current.run(() => login.promise);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOGIN_PROGRESS_POLL_MS * 2);
    });
    expect(result.current.progress?.phase).toBe('starting');
    await act(async () => {
      login.resolve('done');
      await run;
    });
    expect((await run).value).toBe('done');
  });
});
