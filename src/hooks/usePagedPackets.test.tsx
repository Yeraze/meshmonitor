/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { usePagedPackets, type PagedPage } from './usePagedPackets';

type Row = { id: number };
const wrapper = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

describe('usePagedPackets', () => {
  it('pages by offset and de-dups overlapping ids', async () => {
    const fetchPage = vi.fn(async (param: unknown): Promise<PagedPage<Row>> => {
      if (param === 0) return { packets: [{ id: 1 }, { id: 2 }], total: 3 };
      return { packets: [{ id: 2 }, { id: 3 }], total: 3 };
    });
    const { result } = renderHook(
      () => usePagedPackets<Row>({ queryKey: ['t-offset'], canView: true, pageSize: 2, paging: 'offset', fetchPage }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.packets.map(p => p.id)).toEqual([1, 2]));
    expect(result.current.hasMore).toBe(true);
    await act(async () => { await result.current.loadMore(); });
    await waitFor(() => expect(result.current.packets.map(p => p.id)).toEqual([1, 2, 3]));
    expect(fetchPage).toHaveBeenLastCalledWith(2, 2);
  });

  it('follows the keyset cursor and stops when hasMore is false', async () => {
    const fetchPage = vi.fn(async (param: unknown): Promise<PagedPage<Row>> => {
      if (param === null) return { packets: [{ id: 5 }], total: 2, nextCursor: '10_4', hasMore: true };
      return { packets: [{ id: 4 }], total: 2, nextCursor: null, hasMore: false };
    });
    const { result } = renderHook(
      () => usePagedPackets<Row>({ queryKey: ['t-cursor'], canView: true, pageSize: 1, paging: 'cursor', fetchPage }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.packets).toHaveLength(1));
    await act(async () => { await result.current.loadMore(); });
    await waitFor(() => expect(result.current.packets).toHaveLength(2));
    expect(fetchPage).toHaveBeenLastCalledWith('10_4', 1);
    expect(result.current.hasMore).toBe(false);
  });

  it('prependLive adds a row on top and bumps total', async () => {
    const fetchPage = vi.fn(async (): Promise<PagedPage<Row>> => ({ packets: [{ id: 1 }], total: 1, hasMore: false }));
    const { result } = renderHook(
      () => usePagedPackets<Row>({ queryKey: ['t-live'], canView: true, pageSize: 10, paging: 'cursor', fetchPage }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.packets).toHaveLength(1));
    act(() => result.current.prependLive({ id: 9 }));
    await waitFor(() => expect(result.current.packets.map(p => p.id)).toEqual([9, 1]));
    expect(result.current.total).toBe(2);
  });

  it('does not fetch when canView is false', async () => {
    const fetchPage = vi.fn(async (): Promise<PagedPage<Row>> => ({ packets: [], total: 0 }));
    renderHook(
      () => usePagedPackets<Row>({ queryKey: ['t-off'], canView: false, pageSize: 10, paging: 'offset', fetchPage }),
      { wrapper: wrapper() },
    );
    await new Promise(r => setTimeout(r, 20));
    expect(fetchPage).not.toHaveBeenCalled();
  });
});
