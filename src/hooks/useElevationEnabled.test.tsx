/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useElevationEnabled } from './useElevationEnabled';
import apiService from '../services/api';

vi.mock('../services/api', () => ({
  default: {
    get: vi.fn(),
  },
}));

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

describe('useElevationEnabled', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns false when the server sets elevationEnabled to "false"', async () => {
    vi.mocked(apiService.get).mockResolvedValue({ elevationEnabled: 'false' });
    const { result } = renderHook(() => useElevationEnabled(), { wrapper });
    await waitFor(() => expect(result.current).toBe(false));
  });

  it('returns true when elevationEnabled is "true"', async () => {
    vi.mocked(apiService.get).mockResolvedValue({ elevationEnabled: 'true' });
    const { result } = renderHook(() => useElevationEnabled(), { wrapper });
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('returns true when elevationEnabled is absent from the settings map', async () => {
    vi.mocked(apiService.get).mockResolvedValue({});
    const { result } = renderHook(() => useElevationEnabled(), { wrapper });
    await waitFor(() => expect(apiService.get).toHaveBeenCalled());
    expect(result.current).toBe(true);
  });

  it('defaults to true before the query resolves (undefined data)', () => {
    vi.mocked(apiService.get).mockReturnValue(new Promise(() => {})); // never resolves
    const { result } = renderHook(() => useElevationEnabled(), { wrapper });
    expect(result.current).toBe(true);
  });

  it('requests /api/settings', async () => {
    vi.mocked(apiService.get).mockResolvedValue({ elevationEnabled: 'true' });
    renderHook(() => useElevationEnabled(), { wrapper });
    await waitFor(() => expect(apiService.get).toHaveBeenCalledWith('/api/settings'));
  });
});
