/**
 * Tests for useSecurityCheck hook
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useSecurityCheck } from './useSecurityCheck';

// Mock logger
vi.mock('../utils/logger', () => ({
  logger: {
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('useSecurityCheck', () => {
  const mockAuthFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('initial state', () => {
    it('should start with default values', () => {
      mockAuthFetch.mockResolvedValue({
        ok: false,
        status: 404,
      });

      const { result } = renderHook(() => useSecurityCheck('', mockAuthFetch));

      expect(result.current.isDefaultPassword).toBe(false);
      expect(result.current.configIssues).toEqual([]);
    });
  });

  describe('default password check', () => {
    it('should detect default password', async () => {
      mockAuthFetch.mockImplementation((url: string) => {
        if (url.includes('check-default-password')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ isDefaultPassword: true }),
          });
        }
        return Promise.resolve({
          ok: false,
          status: 404,
        });
      });

      const { result } = renderHook(() => useSecurityCheck('http://localhost', mockAuthFetch));

      await waitFor(() => {
        expect(result.current.isDefaultPassword).toBe(true);
      });
    });

    it('should detect non-default password', async () => {
      mockAuthFetch.mockImplementation((url: string) => {
        if (url.includes('check-default-password')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ isDefaultPassword: false }),
          });
        }
        return Promise.resolve({
          ok: false,
          status: 404,
        });
      });

      const { result } = renderHook(() => useSecurityCheck('http://localhost', mockAuthFetch));

      await waitFor(() => {
        expect(mockAuthFetch).toHaveBeenCalledWith('http://localhost/api/auth/check-default-password');
      });

      expect(result.current.isDefaultPassword).toBe(false);
    });

    it('should handle check-default-password error', async () => {
      mockAuthFetch.mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => useSecurityCheck('', mockAuthFetch));

      // Should not crash, remain false
      await waitFor(() => {
        expect(result.current.isDefaultPassword).toBe(false);
      });
    });
  });

  describe('config issues check', () => {
    it('should detect config issues', async () => {
      const mockIssues = [
        {
          type: 'cookie_secure',
          severity: 'warning' as const,
          message: 'Cookies not secure in production',
          docsUrl: 'https://docs.example.com/security',
        },
        {
          type: 'allowed_origins',
          severity: 'error' as const,
          message: 'Allowed origins not configured',
          docsUrl: 'https://docs.example.com/cors',
        },
      ];

      mockAuthFetch.mockImplementation((url: string) => {
        if (url.includes('check-config-issues')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ issues: mockIssues }),
          });
        }
        return Promise.resolve({
          ok: false,
          status: 404,
        });
      });

      const { result } = renderHook(() => useSecurityCheck('http://localhost', mockAuthFetch));

      await waitFor(() => {
        expect(result.current.configIssues).toHaveLength(2);
      });

      expect(result.current.configIssues[0].type).toBe('cookie_secure');
      expect(result.current.configIssues[0].severity).toBe('warning');
      expect(result.current.configIssues[1].type).toBe('allowed_origins');
      expect(result.current.configIssues[1].severity).toBe('error');
    });

    it('should handle empty issues array', async () => {
      mockAuthFetch.mockImplementation((url: string) => {
        if (url.includes('check-config-issues')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ issues: [] }),
          });
        }
        return Promise.resolve({
          ok: false,
          status: 404,
        });
      });

      const { result } = renderHook(() => useSecurityCheck('', mockAuthFetch));

      await waitFor(() => {
        expect(mockAuthFetch).toHaveBeenCalled();
      });

      expect(result.current.configIssues).toEqual([]);
    });

    it('should handle missing issues property', async () => {
      mockAuthFetch.mockImplementation((url: string) => {
        if (url.includes('check-config-issues')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({}), // No issues property
          });
        }
        return Promise.resolve({
          ok: false,
          status: 404,
        });
      });

      const { result } = renderHook(() => useSecurityCheck('', mockAuthFetch));

      await waitFor(() => {
        expect(mockAuthFetch).toHaveBeenCalled();
      });

      expect(result.current.configIssues).toEqual([]);
    });

    it('should handle check-config-issues error', async () => {
      mockAuthFetch.mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => useSecurityCheck('', mockAuthFetch));

      // Should not crash, remain empty
      await waitFor(() => {
        expect(result.current.configIssues).toEqual([]);
      });
    });
  });

  describe('both checks', () => {
    it('should make both API calls', async () => {
      mockAuthFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });

      renderHook(() => useSecurityCheck('http://localhost', mockAuthFetch));

      await waitFor(() => {
        expect(mockAuthFetch).toHaveBeenCalledTimes(2);
      });

      expect(mockAuthFetch).toHaveBeenCalledWith('http://localhost/api/auth/check-default-password');
      expect(mockAuthFetch).toHaveBeenCalledWith('http://localhost/api/auth/check-config-issues');
    });

    it('should use provided baseUrl', async () => {
      mockAuthFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });

      renderHook(() => useSecurityCheck('https://custom.domain.com', mockAuthFetch));

      await waitFor(() => {
        expect(mockAuthFetch).toHaveBeenCalledWith('https://custom.domain.com/api/auth/check-default-password');
        expect(mockAuthFetch).toHaveBeenCalledWith('https://custom.domain.com/api/auth/check-config-issues');
      });
    });
  });
});
