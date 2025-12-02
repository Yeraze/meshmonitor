/**
 * Tests for useAuthFetch hook
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAuthFetch } from './useAuthFetch';

// Mock useCsrf
const mockGetToken = vi.fn();
const mockRefreshToken = vi.fn();
vi.mock('../contexts/CsrfContext', () => ({
  useCsrf: () => ({
    getToken: mockGetToken,
    refreshToken: mockRefreshToken,
  }),
}));

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('useAuthFetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetToken.mockReturnValue('test-csrf-token');
    mockRefreshToken.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('basic functionality', () => {
    it('should return a function', () => {
      const { result } = renderHook(() => useAuthFetch());
      expect(typeof result.current).toBe('function');
    });

    it('should make GET requests without CSRF token', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: 'test' }),
      });

      const { result } = renderHook(() => useAuthFetch());

      await act(async () => {
        await result.current('/api/test');
      });

      expect(mockFetch).toHaveBeenCalledWith('/api/test', expect.objectContaining({
        credentials: 'include',
      }));

      // Check that CSRF token was NOT added to headers
      const callArgs = mockFetch.mock.calls[0][1];
      const headers = callArgs.headers;
      expect(headers.get('X-CSRF-Token')).toBeNull();
    });

    it('should add CSRF token to POST requests', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: 'test' }),
      });

      const { result } = renderHook(() => useAuthFetch());

      await act(async () => {
        await result.current('/api/test', { method: 'POST' });
      });

      const callArgs = mockFetch.mock.calls[0][1];
      const headers = callArgs.headers;
      expect(headers.get('X-CSRF-Token')).toBe('test-csrf-token');
    });

    it('should add CSRF token to PUT requests', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      const { result } = renderHook(() => useAuthFetch());

      await act(async () => {
        await result.current('/api/test', { method: 'PUT' });
      });

      const callArgs = mockFetch.mock.calls[0][1];
      const headers = callArgs.headers;
      expect(headers.get('X-CSRF-Token')).toBe('test-csrf-token');
    });

    it('should add CSRF token to DELETE requests', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      const { result } = renderHook(() => useAuthFetch());

      await act(async () => {
        await result.current('/api/test', { method: 'DELETE' });
      });

      const callArgs = mockFetch.mock.calls[0][1];
      const headers = callArgs.headers;
      expect(headers.get('X-CSRF-Token')).toBe('test-csrf-token');
    });

    it('should add CSRF token to PATCH requests', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      const { result } = renderHook(() => useAuthFetch());

      await act(async () => {
        await result.current('/api/test', { method: 'PATCH' });
      });

      const callArgs = mockFetch.mock.calls[0][1];
      const headers = callArgs.headers;
      expect(headers.get('X-CSRF-Token')).toBe('test-csrf-token');
    });
  });

  describe('CSRF token retry', () => {
    it('should retry on 403 CSRF error', async () => {
      // First call returns 403 CSRF error
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        clone: () => ({
          json: () => Promise.resolve({ error: 'CSRF token invalid' }),
        }),
      });

      // Second call succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ success: true }),
      });

      const { result } = renderHook(() => useAuthFetch());

      await act(async () => {
        await result.current('/api/test', { method: 'POST' });
      });

      // Should have called fetch twice (original + retry)
      expect(mockFetch).toHaveBeenCalledTimes(2);
      // Should have refreshed the token
      expect(mockRefreshToken).toHaveBeenCalled();
    });

    it('should not retry more than once', async () => {
      // Both calls return 403 CSRF error
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        clone: () => ({
          json: () => Promise.resolve({ error: 'CSRF token invalid' }),
        }),
      });

      const { result } = renderHook(() => useAuthFetch());

      await act(async () => {
        await result.current('/api/test', { method: 'POST' });
      });

      // Should have called fetch twice max (original + 1 retry)
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should not retry on non-CSRF 403 errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        clone: () => ({
          json: () => Promise.resolve({ error: 'Access denied' }),
        }),
      });

      const { result } = renderHook(() => useAuthFetch());

      await act(async () => {
        await result.current('/api/test', { method: 'POST' });
      });

      // Should not retry
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockRefreshToken).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should handle 401 errors silently', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
      });

      const { result } = renderHook(() => useAuthFetch());

      let response: Response | undefined;
      await act(async () => {
        response = await result.current('/api/test');
      });

      expect(response?.status).toBe(401);
    });

    it('should handle 403 errors silently', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        clone: () => ({
          json: () => Promise.resolve({ error: 'Forbidden' }),
        }),
      });

      const { result } = renderHook(() => useAuthFetch());

      let response: Response | undefined;
      await act(async () => {
        response = await result.current('/api/test');
      });

      expect(response?.status).toBe(403);
    });

    it('should throw on network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const { result } = renderHook(() => useAuthFetch());

      await expect(
        act(async () => {
          await result.current('/api/test');
        })
      ).rejects.toThrow('Network error');
    });
  });

  describe('credentials', () => {
    it('should always include credentials', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      const { result } = renderHook(() => useAuthFetch());

      await act(async () => {
        await result.current('/api/test');
      });

      expect(mockFetch).toHaveBeenCalledWith('/api/test', expect.objectContaining({
        credentials: 'include',
      }));
    });
  });

  describe('missing CSRF token', () => {
    it('should log error when CSRF token is missing for mutations', async () => {
      mockGetToken.mockReturnValue(null);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      const { result } = renderHook(() => useAuthFetch());

      await act(async () => {
        await result.current('/api/test', { method: 'POST' });
      });

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('NO CSRF TOKEN'));
      consoleSpy.mockRestore();
    });
  });
});
