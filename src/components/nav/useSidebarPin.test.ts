/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { readSidebarPinned, useSidebarPin, SIDEBAR_PINNED_KEY } from './useSidebarPin';

describe('useSidebarPin (#5481)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('reads the shared key, defaulting to unpinned', () => {
    expect(readSidebarPinned()).toBe(false);
    localStorage.setItem(SIDEBAR_PINNED_KEY, 'true');
    expect(readSidebarPinned()).toBe(true);
    expect(renderHook(() => useSidebarPin()).result.current.isPinned).toBe(true);
  });

  it('toggles, persists, and returns the new value', () => {
    const { result } = renderHook(() => useSidebarPin());
    let next: boolean | undefined;
    act(() => { next = result.current.togglePin(); });
    expect(next).toBe(true);
    expect(result.current.isPinned).toBe(true);
    expect(localStorage.getItem(SIDEBAR_PINNED_KEY)).toBe('true');
    act(() => { next = result.current.togglePin(); });
    expect(next).toBe(false);
    expect(localStorage.getItem(SIDEBAR_PINNED_KEY)).toBe('false');
  });

  it('still toggles when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const { result } = renderHook(() => useSidebarPin());
    expect(result.current.isPinned).toBe(false);
    act(() => { result.current.togglePin(); });
    expect(result.current.isPinned).toBe(true);
  });
});
