/**
 * Generic paged packet list on TanStack `useInfiniteQuery` (#6262).
 *
 * One implementation shared by the Meshtastic hook (`usePackets`, offset
 * paging, polled) and the MeshCore hook (`useMeshCorePackets`, keyset cursor
 * paging, socket-fed). It owns id de-dup, `hasMore`/`loadMore`, rate-limit
 * handling, optional polling, and live-row prepending.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';

/** Offset for `paging: 'offset'`, the previous page's `nextCursor` for `'cursor'`. */
export type PagedPageParam = number | string | null;

export interface PagedPage<T> {
  packets: T[];
  total: number;
  /** Keyset cursor for the next page (`paging: 'cursor'`). */
  nextCursor?: string | null;
  /** Server verdict on a further page. When absent, a full page implies more. */
  hasMore?: boolean;
}

export interface UsePagedPacketsOptions<T extends { id?: number | string }> {
  /** Full query key: include every input that changes the result. */
  queryKey: readonly unknown[];
  canView: boolean;
  pageSize: number;
  paging: 'offset' | 'cursor';
  fetchPage: (pageParam: PagedPageParam, pageSize: number) => Promise<PagedPage<T>>;
  /** Poll interval in ms; omit or 0/false for none. */
  pollIntervalMs?: number | false;
}

export interface UsePagedPacketsResult<T> {
  packets: T[];
  total: number;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  rateLimitError: boolean;
  /** Last fetch error, if the query is in an error state. */
  error: Error | null;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
  /** Add a live row to the top of the loaded list (no refetch). */
  prependLive: (row: T) => void;
}

export function usePagedPackets<T extends { id?: number | string }>({
  queryKey,
  canView,
  pageSize,
  paging,
  fetchPage,
  pollIntervalMs,
}: UsePagedPacketsOptions<T>): UsePagedPacketsResult<T> {
  const queryClient = useQueryClient();

  const [rateLimitError, setRateLimitError] = useState(false);
  const rateLimitResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLoadedRawLengthRef = useRef<number>(0);

  const poll = pollIntervalMs ? pollIntervalMs : false;

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading, refetch, error } = useInfiniteQuery({
    queryKey,
    queryFn: async ({ pageParam }) => fetchPage(pageParam as PagedPageParam, pageSize),
    initialPageParam: (paging === 'offset' ? 0 : null) as PagedPageParam,
    getNextPageParam: (lastPage, allPages): PagedPageParam | undefined => {
      if (paging === 'cursor') {
        if (lastPage.hasMore === false) return undefined;
        return lastPage.nextCursor ?? undefined;
      }
      if (lastPage.hasMore === false) return undefined;
      if (lastPage.hasMore === undefined && lastPage.packets.length < pageSize) return undefined;
      return allPages.reduce((sum, page) => sum + page.packets.length, 0);
    },
    enabled: canView,
    refetchInterval: poll,
    refetchIntervalInBackground: false,
    staleTime: poll ? Math.max(0, poll - 1000) : 0,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  // De-dup by id: a poll refetch can shift offsets, and a live row can arrive
  // before the server page that also contains it.
  const packets = useMemo(() => {
    if (!data?.pages) return [] as T[];
    const seen = new Set<number | string>();
    return data.pages
      .flatMap(page => page.packets)
      .filter(p => {
        if (p.id === undefined || p.id === null) return true;
        if (seen.has(p.id)) return false;
        seen.add(p.id);
        return true;
      });
  }, [data?.pages]);

  const total = useMemo(() => {
    if (!data?.pages || data.pages.length === 0) return 0;
    return data.pages[data.pages.length - 1].total;
  }, [data?.pages]);

  const queryKeyHash = JSON.stringify(queryKey);
  useEffect(() => {
    lastLoadedRawLengthRef.current = 0;
  }, [queryKeyHash]);

  // Ref so loadMore keeps a stable identity across data changes.
  const lengthRef = useRef(0);
  lengthRef.current = packets.length;

  const loadMore = useCallback(async () => {
    if (isFetchingNextPage || !hasNextPage || rateLimitError || !canView) return;
    if (lengthRef.current > 0 && lengthRef.current === lastLoadedRawLengthRef.current) return;
    lastLoadedRawLengthRef.current = lengthRef.current;

    try {
      await fetchNextPage();
    } catch (error) {
      console.error('Failed to load more packets:', error);
      if (error instanceof Error && error.message.includes('Too many requests')) {
        setRateLimitError(true);
        if (rateLimitResetTimerRef.current) clearTimeout(rateLimitResetTimerRef.current);
        rateLimitResetTimerRef.current = setTimeout(() => setRateLimitError(false), 15 * 60 * 1000);
      }
    }
  }, [isFetchingNextPage, hasNextPage, rateLimitError, canView, fetchNextPage]);

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey });
    await refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- #6262 queryKey identity is hashed by value
  }, [queryClient, queryKeyHash, refetch]);

  const prependLive = useCallback((row: T) => {
    queryClient.setQueryData<InfiniteData<PagedPage<T>, PagedPageParam>>(queryKey, old => {
      if (!old || old.pages.length === 0) return old;
      return {
        ...old,
        // `total` is read from the last page, so every page's count moves.
        pages: old.pages.map((page, i) => ({
          ...page,
          packets: i === 0 ? [row, ...page.packets] : page.packets,
          total: page.total + 1,
        })),
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- #6262 queryKey identity is hashed by value
  }, [queryClient, queryKeyHash]);

  useEffect(() => {
    return () => {
      if (rateLimitResetTimerRef.current) clearTimeout(rateLimitResetTimerRef.current);
    };
  }, []);

  return {
    packets,
    total,
    loading: isLoading,
    loadingMore: isFetchingNextPage,
    hasMore: hasNextPage ?? true,
    rateLimitError,
    error: error instanceof Error ? error : null,
    loadMore,
    refresh,
    prependLive,
  };
}
