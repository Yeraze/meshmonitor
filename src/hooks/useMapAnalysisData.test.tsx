/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { usePositions } from './useMapAnalysisData';
import * as api from '../services/analysisApi';

vi.mock('../services/analysisApi');

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
