/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { usePositions, useMeshCoreNeighbors } from './useMapAnalysisData';
import * as api from '../services/analysisApi';
import { useDashboardSources } from './useDashboardData';

vi.mock('../services/analysisApi');
vi.mock('./useDashboardData', () => ({ useDashboardSources: vi.fn() }));

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

describe('usePositions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does NOT fetch when disabled', () => {
    vi.mocked(api.fetchPositionsPage).mockResolvedValue({
      items: [],
      pageSize: 500,
      hasMore: false,
      nextCursor: null,
    });
    renderHook(
      () => usePositions({ enabled: false, sources: [], lookbackHours: 24 }),
      { wrapper },
    );
    expect(api.fetchPositionsPage).not.toHaveBeenCalled();
  });

  it('does NOT fetch when sources is empty', () => {
    vi.mocked(api.fetchPositionsPage).mockResolvedValue({
      items: [],
      pageSize: 500,
      hasMore: false,
      nextCursor: null,
    });
    renderHook(
      () => usePositions({ enabled: true, sources: [], lookbackHours: 24 }),
      { wrapper },
    );
    expect(api.fetchPositionsPage).not.toHaveBeenCalled();
  });

  it('aggregates pages across multiple fetches', async () => {
    vi.mocked(api.fetchPositionsPage)
      .mockResolvedValueOnce({
        items: [{ id: 1 } as any],
        pageSize: 1,
        hasMore: true,
        nextCursor: 'c1',
      })
      .mockResolvedValueOnce({
        items: [{ id: 2 } as any],
        pageSize: 1,
        hasMore: false,
        nextCursor: null,
      });
    const { result } = renderHook(
      () => usePositions({ enabled: true, sources: ['s'], lookbackHours: 24 }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(result.current.progress.percent).toBe(100);
    expect(result.current.isLoading).toBe(false);
  });
});

describe('useMeshCoreNeighbors', () => {
  const sources = [
    { id: 'mt', name: 'Meshtastic', type: 'meshtastic_tcp', enabled: true },
    { id: 'mqtt', name: 'MQTT', type: 'mqtt', enabled: true },
    { id: 'mcmqtt', name: 'MC ingest', type: 'meshcore_mqtt', enabled: true },
    { id: 'mc', name: 'MeshCore', type: 'meshcore', enabled: true },
    { id: 'mcoff', name: 'MeshCore off', type: 'meshcore', enabled: false },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.fetchMeshCoreNeighbors).mockResolvedValue({ items: [] });
    vi.mocked(useDashboardSources).mockReturnValue({ data: sources } as any);
  });

  it('does NOT fetch for a non-MeshCore source', async () => {
    const { result } = renderHook(
      () => useMeshCoreNeighbors({ enabled: true, sources: ['mt'], lookbackHours: 24 }),
      { wrapper },
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.fetchStatus).toBe('idle');
    expect(api.fetchMeshCoreNeighbors).not.toHaveBeenCalled();
  });

  it('does NOT fetch for MQTT, MeshCore-ingest or disabled MeshCore sources', async () => {
    renderHook(
      () =>
        useMeshCoreNeighbors({
          enabled: true,
          sources: ['mqtt', 'mcmqtt', 'mcoff'],
          lookbackHours: 24,
        }),
      { wrapper },
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(api.fetchMeshCoreNeighbors).not.toHaveBeenCalled();
  });

  it('does NOT fetch before the source list has loaded', async () => {
    vi.mocked(useDashboardSources).mockReturnValue({ data: undefined } as any);
    renderHook(
      () => useMeshCoreNeighbors({ enabled: true, sources: ['mc'], lookbackHours: 24 }),
      { wrapper },
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(api.fetchMeshCoreNeighbors).not.toHaveBeenCalled();
  });

  it('fetches for a MeshCore source', async () => {
    const { result } = renderHook(
      () => useMeshCoreNeighbors({ enabled: true, sources: ['mc'], lookbackHours: 24 }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.fetchMeshCoreNeighbors).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.fetchMeshCoreNeighbors).mock.calls[0][0].sources).toEqual(['mc']);
  });

  it('requests only the MeshCore sources out of a mixed list', async () => {
    const { result } = renderHook(
      () =>
        useMeshCoreNeighbors({
          enabled: true,
          sources: ['mt', 'mqtt', 'mcmqtt', 'mc', 'mcoff'],
          lookbackHours: 24,
        }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(vi.mocked(api.fetchMeshCoreNeighbors).mock.calls[0][0].sources).toEqual(['mc']);
  });

  it('does NOT fetch when disabled, even for a MeshCore source', async () => {
    renderHook(
      () => useMeshCoreNeighbors({ enabled: false, sources: ['mc'], lookbackHours: 24 }),
      { wrapper },
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(api.fetchMeshCoreNeighbors).not.toHaveBeenCalled();
  });
});
