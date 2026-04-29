/**
 * Tests for useIsDesktop
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useIsDesktop } from './useIsDesktop';

describe('useIsDesktop', () => {
  let listeners: Array<(e: { matches: boolean }) => void>;
  let matches: boolean;

  beforeEach(() => {
    listeners = [];
    matches = true;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      media: query,
      get matches() {
        return matches;
      },
      addEventListener: (_: string, cb: (e: { matches: boolean }) => void) => {
        listeners.push(cb);
      },
      removeEventListener: (_: string, cb: (e: { matches: boolean }) => void) => {
        listeners = listeners.filter(l => l !== cb);
      },
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    })) as unknown as typeof window.matchMedia;
  });

  it('returns true when (pointer: fine) matches', () => {
    matches = true;
    const { result } = renderHook(() => useIsDesktop());
    expect(result.current).toBe(true);
  });

  it('returns false when (pointer: fine) does not match', () => {
    matches = false;
    const { result } = renderHook(() => useIsDesktop());
    expect(result.current).toBe(false);
  });

  it('updates when the media query change event fires', () => {
    matches = true;
    const { result } = renderHook(() => useIsDesktop());
    expect(result.current).toBe(true);

    act(() => {
      matches = false;
      listeners.forEach(cb => cb({ matches: false }));
    });
    expect(result.current).toBe(false);
  });
});
