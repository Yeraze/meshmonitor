/**
 * Tests for useVersionCheck hook
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useVersionCheck, VERSION_CHECK_INTERVAL_MS } from './useVersionCheck';
import { ApiError } from '../services/api';

const getMock = vi.fn();
vi.mock('../services/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../services/api')>();
  return {
    ...actual,
    default: {
      ...actual.default,
      get: (...args: unknown[]) => getMock(...args),
    },
  };
});

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
    },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useVersionCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should export VERSION_CHECK_INTERVAL_MS constant', () => {
    expect(VERSION_CHECK_INTERVAL_MS).toBe(4 * 60 * 60 * 1000); // 4 hours
  });

  it('should start with no update available before the query resolves', () => {
    getMock.mockReturnValue(new Promise(() => {})); // never resolves
    const { result } = renderHook(() => useVersionCheck(''), { wrapper: createWrapper() });

    expect(result.current.updateAvailable).toBe(false);
    expect(result.current.latestVersion).toBe('');
    expect(result.current.releaseUrl).toBe('');
  });

  it('should request /api/version/check', async () => {
    getMock.mockResolvedValue({ updateAvailable: false });
    renderHook(() => useVersionCheck(''), { wrapper: createWrapper() });

    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/api/version/check'));
  });

  it('should reflect updateAvailable and version info from the payload', async () => {
    getMock.mockResolvedValue({
      updateAvailable: true,
      currentVersion: '1.0.0',
      latestVersion: '2.0.0',
      releaseUrl: 'https://github.com/releases/v2.0.0',
    });

    const { result } = renderHook(() => useVersionCheck(''), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.updateAvailable).toBe(true));
    expect(result.current.latestVersion).toBe('2.0.0');
    expect(result.current.releaseUrl).toBe('https://github.com/releases/v2.0.0');
  });

  it('should not surface latestVersion/releaseUrl when versions match', async () => {
    getMock.mockResolvedValue({
      updateAvailable: false,
      currentVersion: '1.0.0',
      latestVersion: '1.0.0',
    });

    const { result } = renderHook(() => useVersionCheck(''), { wrapper: createWrapper() });

    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(result.current.updateAvailable).toBe(false);
    expect(result.current.latestVersion).toBe('');
  });

  it('should surface version info even when images are not ready yet', async () => {
    getMock.mockResolvedValue({
      updateAvailable: false, // images not ready
      currentVersion: '1.0.0',
      latestVersion: '2.0.0',
      releaseUrl: 'https://github.com/releases/v2.0.0',
    });

    const { result } = renderHook(() => useVersionCheck(''), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.latestVersion).toBe('2.0.0'));
    expect(result.current.releaseUrl).toBe('https://github.com/releases/v2.0.0');
    expect(result.current.updateAvailable).toBe(false);
  });

  it('should default deploymentMethod to "manual" when absent', async () => {
    getMock.mockResolvedValue({ updateAvailable: false });
    const { result } = renderHook(() => useVersionCheck(''), { wrapper: createWrapper() });

    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(result.current.deploymentMethod).toBe('manual');
  });

  it('should surface deploymentMethod from the payload', async () => {
    getMock.mockResolvedValue({ updateAvailable: false, deploymentMethod: 'docker' });
    const { result } = renderHook(() => useVersionCheck(''), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.deploymentMethod).toBe('docker'));
  });

  it('should mark the query as errored on a 404 so refetchInterval stops polling', async () => {
    getMock.mockRejectedValue(new ApiError('Not found', 404));

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    renderHook(() => useVersionCheck(''), { wrapper });

    await waitFor(() => {
      const state = queryClient.getQueryState(['version-check']);
      expect(state?.status).toBe('error');
      expect(state?.error).toBeInstanceOf(ApiError);
      expect((state?.error as ApiError).status).toBe(404);
    });
  });

  it('dismissUpdate suppresses the banner without clearing the query result', async () => {
    getMock.mockResolvedValue({
      updateAvailable: true,
      currentVersion: '1.0.0',
      latestVersion: '2.0.0',
      releaseUrl: 'https://example.com',
    });

    const { result } = renderHook(() => useVersionCheck(''), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.updateAvailable).toBe(true));

    act(() => {
      result.current.dismissUpdate();
    });

    expect(result.current.updateAvailable).toBe(false);
    // Version info should still be available - the query wasn't cleared.
    expect(result.current.latestVersion).toBe('2.0.0');
  });

  it('should not crash on a network error and should keep updateAvailable false', async () => {
    getMock.mockRejectedValue(new Error('Network error'));
    const { result } = renderHook(() => useVersionCheck(''), { wrapper: createWrapper() });

    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(result.current.updateAvailable).toBe(false);
  });
});
