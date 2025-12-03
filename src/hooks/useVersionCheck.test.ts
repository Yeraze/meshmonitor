/**
 * Tests for useVersionCheck hook
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useVersionCheck, VERSION_CHECK_INTERVAL_MS } from './useVersionCheck';

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock logger
vi.mock('../utils/logger', () => ({
  logger: {
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Helper to flush pending promises
const flushPromises = () => new Promise(resolve => setTimeout(resolve, 0));

describe('useVersionCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('initial state', () => {
    it('should start with no update available', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ updateAvailable: false }),
      });

      const { result } = renderHook(() => useVersionCheck(''));

      expect(result.current.updateAvailable).toBe(false);
      expect(result.current.latestVersion).toBe('');
      expect(result.current.releaseUrl).toBe('');
      
      // Flush any pending timers
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    });

    it('should export VERSION_CHECK_INTERVAL_MS constant', () => {
      expect(VERSION_CHECK_INTERVAL_MS).toBe(4 * 60 * 60 * 1000); // 4 hours
    });
  });

  describe('update checking', () => {
    it('should check for updates on mount', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          updateAvailable: true,
          latestVersion: '2.0.0',
          currentVersion: '1.0.0',
          releaseUrl: 'https://github.com/releases/v2.0.0',
        }),
      });

      const { result } = renderHook(() => useVersionCheck('http://localhost'));

      // Flush the initial fetch
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockFetch).toHaveBeenCalledWith('http://localhost/api/version/check');
      expect(result.current.updateAvailable).toBe(true);
      expect(result.current.latestVersion).toBe('2.0.0');
      expect(result.current.releaseUrl).toBe('https://github.com/releases/v2.0.0');
    });

    it('should not show update when versions match', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          updateAvailable: false,
          latestVersion: '1.0.0',
          currentVersion: '1.0.0',
        }),
      });

      const { result } = renderHook(() => useVersionCheck(''));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      
      expect(mockFetch).toHaveBeenCalled();
      expect(result.current.updateAvailable).toBe(false);
    });

    it('should update version info when newer version exists', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          updateAvailable: false, // Images not ready yet
          latestVersion: '2.0.0',
          currentVersion: '1.0.0',
          releaseUrl: 'https://github.com/releases/v2.0.0',
        }),
      });

      const { result } = renderHook(() => useVersionCheck(''));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // Version info should be updated
      expect(result.current.latestVersion).toBe('2.0.0');
      expect(result.current.releaseUrl).toBe('https://github.com/releases/v2.0.0');
      // But update not available yet (images not ready)
      expect(result.current.updateAvailable).toBe(false);
    });
  });

  describe('polling behavior', () => {
    it('should poll at configured interval', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ updateAvailable: false }),
      });

      renderHook(() => useVersionCheck(''));

      // Initial call
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Advance time by check interval
      await act(async () => {
        await vi.advanceTimersByTimeAsync(VERSION_CHECK_INTERVAL_MS);
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should stop polling on 404', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
      });

      renderHook(() => useVersionCheck(''));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Advance time - should not poll again after 404
      await act(async () => {
        await vi.advanceTimersByTimeAsync(VERSION_CHECK_INTERVAL_MS);
      });

      // Still only 1 call because interval was cleared
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should cleanup interval on unmount', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ updateAvailable: false }),
      });

      const { unmount } = renderHook(() => useVersionCheck(''));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);

      unmount();

      // Advance time - should not poll after unmount
      await act(async () => {
        await vi.advanceTimersByTimeAsync(VERSION_CHECK_INTERVAL_MS);
      });

      // Still only 1 call
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('dismissUpdate', () => {
    it('should set updateAvailable to false when dismissed', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          updateAvailable: true,
          latestVersion: '2.0.0',
          currentVersion: '1.0.0',
        }),
      });

      const { result } = renderHook(() => useVersionCheck(''));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(result.current.updateAvailable).toBe(true);

      act(() => {
        result.current.dismissUpdate();
      });

      expect(result.current.updateAvailable).toBe(false);
      // Version info should still be available
      expect(result.current.latestVersion).toBe('2.0.0');
    });

    it('should be a stable function reference', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ updateAvailable: false }),
      });

      const { result, rerender } = renderHook(() => useVersionCheck(''));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      const firstDismiss = result.current.dismissUpdate;
      
      rerender();
      
      expect(result.current.dismissUpdate).toBe(firstDismiss);
    });
  });

  describe('error handling', () => {
    it('should handle fetch errors gracefully', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => useVersionCheck(''));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockFetch).toHaveBeenCalled();
      // Should not crash, should remain false
      expect(result.current.updateAvailable).toBe(false);
    });

    it('should handle non-200 responses gracefully', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
      });

      const { result } = renderHook(() => useVersionCheck(''));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockFetch).toHaveBeenCalled();
      // Should not crash, should remain false
      expect(result.current.updateAvailable).toBe(false);
    });
  });
});
