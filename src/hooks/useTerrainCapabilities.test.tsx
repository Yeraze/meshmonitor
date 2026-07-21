/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useTerrainCapabilities } from './useTerrainCapabilities';
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

describe('useTerrainCapabilities', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads the enveloped body.data shape (not the raw body)', async () => {
    vi.mocked(apiService.get).mockResolvedValue({
      success: true,
      data: { enabled: true, terrainTiles: true, provider: 'terrarium' },
    });
    const { result } = renderHook(() => useTerrainCapabilities(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.enabled).toBe(true);
    expect(result.current.terrainTiles).toBe(true);
  });

  it('defaults to unavailable (not available) while loading', () => {
    vi.mocked(apiService.get).mockReturnValue(new Promise(() => {})); // never resolves
    const { result } = renderHook(() => useTerrainCapabilities(), { wrapper });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.enabled).toBe(false);
    expect(result.current.terrainTiles).toBe(false);
  });

  it('reflects elevation disabled server-side', async () => {
    vi.mocked(apiService.get).mockResolvedValue({
      success: true,
      data: { enabled: false, terrainTiles: false, provider: 'terrarium' },
    });
    const { result } = renderHook(() => useTerrainCapabilities(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.enabled).toBe(false);
    expect(result.current.terrainTiles).toBe(false);
  });

  it('reflects a JSON elevation source: enabled but no terrain tiles', async () => {
    vi.mocked(apiService.get).mockResolvedValue({
      success: true,
      data: { enabled: true, terrainTiles: false, provider: 'json' },
    });
    const { result } = renderHook(() => useTerrainCapabilities(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.enabled).toBe(true);
    expect(result.current.terrainTiles).toBe(false);
  });

  it('requests /api/elevation/capabilities', async () => {
    vi.mocked(apiService.get).mockResolvedValue({
      success: true,
      data: { enabled: true, terrainTiles: true, provider: 'terrarium' },
    });
    renderHook(() => useTerrainCapabilities(), { wrapper });
    await waitFor(() =>
      expect(apiService.get).toHaveBeenCalledWith('/api/elevation/capabilities'),
    );
  });
});
