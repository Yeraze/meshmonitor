/**
 * Tests for useUnifiedPackets hook
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactNode } from 'react';
import { useUnifiedPackets } from './useUnifiedPackets';
import * as packetApi from '../services/packetApi';
import { PacketLog, UnifiedPacketsResponse } from '../types/packet';

vi.mock('../services/packetApi', () => ({
  getUnifiedPackets: vi.fn(),
}));

const mockGet = vi.mocked(packetApi.getUnifiedPackets);

const mkPkt = (id: number, sourceId: string, ts: number = 1_700_000_000_000): PacketLog => ({
  id,
  from_node: 12345,
  timestamp: ts,
  portnum: 1,
  encrypted: false,
  sourceId,
  sourceName: sourceId === 'a' ? 'Source A' : 'Source B',
});

const mkResp = (packets: PacketLog[], hasMore: boolean, nextCursor: string | null): UnifiedPacketsResponse => ({
  packets,
  hasMore,
  nextCursor,
  sources: [
    { id: 'a', name: 'Source A' },
    { id: 'b', name: 'Source B' },
  ],
});

const createTestQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: Infinity, refetchInterval: false, refetchOnWindowFocus: false },
    },
  });

const createWrapper = (queryClient: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };

describe('useUnifiedPackets', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = createTestQueryClient();
  });

  afterEach(() => {
    queryClient.clear();
  });

  it('loads the first page and exposes the readable sources', async () => {
    mockGet.mockResolvedValue(mkResp([mkPkt(1, 'a'), mkPkt(2, 'b')], false, null));

    const { result } = renderHook(() => useUnifiedPackets({ canView: true, filters: {} }), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.packets).toHaveLength(2);
    expect(result.current.sources.map((s) => s.id)).toEqual(['a', 'b']);
    expect(result.current.hasMore).toBe(false);
    // First call uses a null cursor.
    expect(mockGet.mock.calls[0][0]).toBeNull();
  });

  it('advances the keyset cursor on loadMore and dedups by (sourceId,id)', async () => {
    mockGet
      .mockResolvedValueOnce(mkResp([mkPkt(10, 'a', 1_700_000_000_010)], true, '1700000000010_10'))
      // Second page repeats the boundary row (id 10 from a) plus a new one.
      .mockResolvedValueOnce(mkResp([mkPkt(10, 'a', 1_700_000_000_010), mkPkt(9, 'b', 1_700_000_000_009)], false, null));

    const { result } = renderHook(() => useUnifiedPackets({ canView: true, filters: {} }), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      await result.current.loadMore();
    });

    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
    // Second fetch used the nextCursor from page 1.
    expect(mockGet.mock.calls[1][0]).toBe('1700000000010_10');
    // Boundary duplicate (a,10) collapsed → 2 unique rows.
    await waitFor(() => expect(result.current.packets).toHaveLength(2));
    expect(result.current.hasMore).toBe(false);
  });

  it('does not fetch when canView is false', () => {
    renderHook(() => useUnifiedPackets({ canView: false, filters: {} }), {
      wrapper: createWrapper(queryClient),
    });
    expect(mockGet).not.toHaveBeenCalled();
  });
});
