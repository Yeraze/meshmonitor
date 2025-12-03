/**
 * Tests for useAutoUpgrade hook
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
  useAutoUpgrade,
  BASE_POLL_INTERVAL_MS,
  MAX_POLL_INTERVAL_MS,
  MAX_POLL_ATTEMPTS,
  RELOAD_DELAY_MS,
} from './useAutoUpgrade';

// Mock logger
vi.mock('../utils/logger', () => ({
  logger: {
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock window.location.reload
const mockReload = vi.fn();
Object.defineProperty(window, 'location', {
  value: { reload: mockReload },
  writable: true,
});

describe('useAutoUpgrade', () => {
  const mockAuthFetch = vi.fn();
  const mockShowToast = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('exported constants', () => {
    it('should export polling configuration constants', () => {
      expect(BASE_POLL_INTERVAL_MS).toBe(10000); // 10 seconds
      expect(MAX_POLL_INTERVAL_MS).toBe(30000); // 30 seconds
      expect(MAX_POLL_ATTEMPTS).toBe(60);
      expect(RELOAD_DELAY_MS).toBe(3000); // 3 seconds
    });
  });

  describe('initial state', () => {
    it('should start with upgrade disabled', () => {
      mockAuthFetch.mockResolvedValue({
        ok: false,
        status: 404,
      });

      const { result } = renderHook(() =>
        useAutoUpgrade('', mockAuthFetch, mockShowToast)
      );

      expect(result.current.upgradeEnabled).toBe(false);
      expect(result.current.upgradeInProgress).toBe(false);
      expect(result.current.upgradeStatus).toBe('');
      expect(result.current.upgradeProgress).toBe(0);
      expect(typeof result.current.triggerUpgrade).toBe('function');
    });
  });

  describe('upgrade availability check', () => {
    it('should enable upgrade for Docker deployments', async () => {
      mockAuthFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          enabled: true,
          deploymentMethod: 'docker',
        }),
      });

      const { result } = renderHook(() =>
        useAutoUpgrade('http://localhost', mockAuthFetch)
      );

      await waitFor(() => {
        expect(result.current.upgradeEnabled).toBe(true);
      });
    });

    it('should not enable upgrade for non-Docker deployments', async () => {
      mockAuthFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          enabled: true,
          deploymentMethod: 'manual',
        }),
      });

      const { result } = renderHook(() =>
        useAutoUpgrade('http://localhost', mockAuthFetch)
      );

      await waitFor(() => {
        expect(mockAuthFetch).toHaveBeenCalled();
      });

      expect(result.current.upgradeEnabled).toBe(false);
    });

    it('should not enable upgrade when disabled', async () => {
      mockAuthFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          enabled: false,
          deploymentMethod: 'docker',
        }),
      });

      const { result } = renderHook(() =>
        useAutoUpgrade('http://localhost', mockAuthFetch)
      );

      await waitFor(() => {
        expect(mockAuthFetch).toHaveBeenCalled();
      });

      expect(result.current.upgradeEnabled).toBe(false);
    });

    it('should handle status check error gracefully', async () => {
      mockAuthFetch.mockRejectedValueOnce(new Error('Network error'));

      const { result } = renderHook(() =>
        useAutoUpgrade('http://localhost', mockAuthFetch)
      );

      await waitFor(() => {
        expect(mockAuthFetch).toHaveBeenCalled();
      });

      // Should not crash, remain disabled
      expect(result.current.upgradeEnabled).toBe(false);
    });
  });

  describe('triggerUpgrade', () => {
    it('should trigger upgrade successfully', async () => {
      // Initial status check
      mockAuthFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          enabled: true,
          deploymentMethod: 'docker',
        }),
      });

      const { result } = renderHook(() =>
        useAutoUpgrade('http://localhost', mockAuthFetch, mockShowToast)
      );

      await waitFor(() => {
        expect(result.current.upgradeEnabled).toBe(true);
      });

      // Mock trigger response
      mockAuthFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          upgradeId: 'upgrade-123',
        }),
      });

      // Mock status polling - return in_progress
      mockAuthFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          status: 'in_progress',
          progress: 50,
          currentStep: 'Downloading...',
        }),
      });

      await act(async () => {
        result.current.triggerUpgrade('2.0.0');
      });

      expect(result.current.upgradeInProgress).toBe(true);
      expect(mockShowToast).toHaveBeenCalledWith(
        'Upgrade initiated! The application will restart shortly.',
        'info'
      );
    });

    it('should handle failed trigger', async () => {
      // Initial status check
      mockAuthFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          enabled: true,
          deploymentMethod: 'docker',
        }),
      });

      const { result } = renderHook(() =>
        useAutoUpgrade('http://localhost', mockAuthFetch, mockShowToast)
      );

      await waitFor(() => {
        expect(result.current.upgradeEnabled).toBe(true);
      });

      // Mock failed trigger
      mockAuthFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          success: false,
          message: 'Version not found',
        }),
      });

      await act(async () => {
        await result.current.triggerUpgrade('invalid-version');
      });

      expect(result.current.upgradeInProgress).toBe(false);
      expect(mockShowToast).toHaveBeenCalledWith(
        'Upgrade failed: Version not found',
        'error'
      );
    });

    it('should not trigger if upgrade already in progress', async () => {
      // Initial status check
      mockAuthFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          enabled: true,
          deploymentMethod: 'docker',
        }),
      });

      const { result } = renderHook(() =>
        useAutoUpgrade('http://localhost', mockAuthFetch, mockShowToast)
      );

      await waitFor(() => {
        expect(result.current.upgradeEnabled).toBe(true);
      });

      // Mock successful trigger
      mockAuthFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          upgradeId: 'upgrade-123',
        }),
      });

      // Mock polling response
      mockAuthFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          status: 'in_progress',
          progress: 50,
        }),
      });

      // First trigger
      await act(async () => {
        result.current.triggerUpgrade('2.0.0');
      });

      const callCountAfterFirst = mockAuthFetch.mock.calls.length;

      // Second trigger should be ignored
      await act(async () => {
        result.current.triggerUpgrade('2.0.0');
      });

      // No additional calls (since upgradeInProgress is true)
      expect(mockAuthFetch.mock.calls.length).toBe(callCountAfterFirst);
    });
  });

  describe('upgrade polling', () => {
    it('should handle completed upgrade', async () => {
      vi.useFakeTimers();
      
      // Initial status check
      mockAuthFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          enabled: true,
          deploymentMethod: 'docker',
        }),
      });

      const { result } = renderHook(() =>
        useAutoUpgrade('http://localhost', mockAuthFetch, mockShowToast)
      );

      // Wait for initial effect
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // Mock trigger
      mockAuthFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          upgradeId: 'upgrade-123',
        }),
      });

      // Mock completed status
      mockAuthFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          status: 'complete',
          progress: 100,
        }),
      });

      await act(async () => {
        result.current.triggerUpgrade('2.0.0');
        await vi.runAllTimersAsync();
      });

      expect(result.current.upgradeProgress).toBe(100);
      expect(mockShowToast).toHaveBeenCalledWith('Upgrade complete! Reloading...', 'success');

      // Advance time for reload
      await act(async () => {
        await vi.advanceTimersByTimeAsync(RELOAD_DELAY_MS);
      });

      expect(mockReload).toHaveBeenCalled();
      
      vi.useRealTimers();
    });

    it('should handle failed upgrade', async () => {
      vi.useFakeTimers();
      
      // Initial status check
      mockAuthFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          enabled: true,
          deploymentMethod: 'docker',
        }),
      });

      const { result } = renderHook(() =>
        useAutoUpgrade('http://localhost', mockAuthFetch, mockShowToast)
      );

      // Wait for initial effect
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // Mock trigger
      mockAuthFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          upgradeId: 'upgrade-123',
        }),
      });

      // Mock failed status
      mockAuthFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          status: 'failed',
        }),
      });

      await act(async () => {
        result.current.triggerUpgrade('2.0.0');
        await vi.runAllTimersAsync();
      });

      expect(result.current.upgradeStatus).toBe('Failed');
      expect(result.current.upgradeInProgress).toBe(false);
      expect(mockShowToast).toHaveBeenCalledWith(
        'Upgrade failed. Check logs for details.',
        'error'
      );
      
      vi.useRealTimers();
    });
  });

  describe('cleanup', () => {
    it('should cleanup polling on unmount', async () => {
      mockAuthFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          enabled: true,
          deploymentMethod: 'docker',
        }),
      });

      const { unmount } = renderHook(() =>
        useAutoUpgrade('http://localhost', mockAuthFetch)
      );

      await waitFor(() => {
        expect(mockAuthFetch).toHaveBeenCalled();
      });

      // Should not throw
      unmount();
    });
  });
});
