/**
 * useNow — #5277 P4b review follow-up (PR #5353).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useNow } from './useNow';

const START_MS = 1_700_000_000_000;

describe('useNow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the current time at mount', () => {
    const { result } = renderHook(() => useNow(30_000));
    expect(result.current).toBe(START_MS);
  });

  it('ticks forward on the given interval while enabled', () => {
    // `vi.advanceTimersByTime` both moves the fake clock forward AND fires
    // due timers — it must not be combined with a separate `setSystemTime`
    // call for the same span, or the clock advances twice.
    const { result } = renderHook(() => useNow(30_000));

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(result.current).toBe(START_MS + 30_000);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(result.current).toBe(START_MS + 60_000);
  });

  it('does not tick, and reads the value at the moment it was disabled, when enabled=false', () => {
    const { result } = renderHook(() => useNow(30_000, false));

    act(() => {
      vi.advanceTimersByTime(120_000);
    });

    expect(result.current).toBe(START_MS);
  });

  it('starts ticking once enabled flips from false to true, catching up immediately', () => {
    let enabled = false;
    const { result, rerender } = renderHook(() => useNow(30_000, enabled));
    expect(result.current).toBe(START_MS);

    // Real time elapsed while disabled (no interval running, so this is
    // just the fake clock moving on, no timers due).
    act(() => {
      vi.advanceTimersByTime(90_000);
    });
    expect(result.current).toBe(START_MS); // still frozen — was disabled throughout

    enabled = true;
    act(() => {
      rerender();
    });

    // Catches up to "now" immediately on enable, without waiting a full tick.
    expect(result.current).toBe(START_MS + 90_000);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(result.current).toBe(START_MS + 120_000);
  });

  it('stops ticking once enabled flips from true to false', () => {
    let enabled = true;
    const { result, rerender } = renderHook(() => useNow(30_000, enabled));

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(result.current).toBe(START_MS + 30_000);

    enabled = false;
    act(() => {
      rerender();
    });

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    // No further ticks once disabled — stays at the value from the last tick.
    expect(result.current).toBe(START_MS + 30_000);
  });

  it('clears the interval on unmount (no timers left pending)', () => {
    const { unmount } = renderHook(() => useNow(30_000));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
