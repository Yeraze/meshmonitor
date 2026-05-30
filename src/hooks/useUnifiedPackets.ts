/**
 * Hook for the cross-source Unified Packet Monitor stream.
 *
 * Mirrors usePackets but talks to `/api/unified/packets`, which merges packets
 * from every readable source (one row per receiving source — NO dedup) and
 * paginates with a composite keyset cursor instead of an offset. Uses TanStack
 * useInfiniteQuery for caching, request dedup, and polling.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { PacketLog, UnifiedPacketFilters, UnifiedSourceRef } from '../types/packet';
import { getUnifiedPackets } from '../services/packetApi';

const PACKET_FETCH_LIMIT = 100;
const POLL_INTERVAL_MS = 5000;

export const UNIFIED_PACKETS_QUERY_KEY = ['unified-packets'] as const;

export function getUnifiedPacketsQueryKey(filters: UnifiedPacketFilters) {
  return [...UNIFIED_PACKETS_QUERY_KEY, filters] as const;
}

interface UseUnifiedPacketsOptions {
  canView: boolean;
  filters: UnifiedPacketFilters;
  /** When true, stop live polling (keeps the current data). */
  paused?: boolean;
}

interface UseUnifiedPacketsResult {
  packets: PacketLog[];
  /** Every readable source (for the source filter dropdown). */
  sources: UnifiedSourceRef[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  rateLimitError: boolean;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function useUnifiedPackets({ canView, filters, paused = false }: UseUnifiedPacketsOptions): UseUnifiedPacketsResult {
  const queryClient = useQueryClient();
  const [rateLimitError, setRateLimitError] = useState(false);
  const rateLimitResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const queryKey = useMemo(() => getUnifiedPacketsQueryKey(filters), [filters]);

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading, refetch } = useInfiniteQuery({
    queryKey,
    queryFn: async ({ pageParam }) => getUnifiedPackets(pageParam ?? null, PACKET_FETCH_LIMIT, filters),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextCursor : undefined),
    enabled: canView,
    refetchInterval: paused ? false : POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    staleTime: POLL_INTERVAL_MS - 1000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  // Flatten pages, deduplicating by composite (sourceId, id) key. Polling refetch
  // can re-surface boundary rows; the keyset cursor makes this rare but we guard
  // anyway (belt-and-suspenders, mirrors usePackets).
  const packets = useMemo(() => {
    if (!data?.pages) return [];
    const all = data.pages.flatMap((page) => page.packets);
    const seen = new Set<string>();
    return all.filter((p) => {
      const key = `${p.sourceId ?? ''}_${p.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [data?.pages]);

  // Sources come from the most recent page (server returns all readable sources).
  const sources = useMemo<UnifiedSourceRef[]>(() => {
    if (!data?.pages || data.pages.length === 0) return [];
    return data.pages[data.pages.length - 1].sources ?? [];
  }, [data?.pages]);

  const loadMore = useCallback(async () => {
    if (isFetchingNextPage || !hasNextPage || rateLimitError || !canView) return;
    try {
      await fetchNextPage();
    } catch (error) {
      console.error('Failed to load more unified packets:', error);
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
  }, [queryClient, queryKey, refetch]);

  useEffect(() => {
    return () => {
      if (rateLimitResetTimerRef.current) clearTimeout(rateLimitResetTimerRef.current);
    };
  }, []);

  return {
    packets,
    sources,
    loading: isLoading,
    loadingMore: isFetchingNextPage,
    hasMore: hasNextPage ?? false,
    rateLimitError,
    loadMore,
    refresh,
  };
}
