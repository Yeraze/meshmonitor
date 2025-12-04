/**
 * Hook for managing packet data fetching and state using TanStack Query
 *
 * Provides packet data management for PacketMonitorPanel including:
 * - Initial fetch and polling with automatic cache management
 * - Infinite scroll/load more with useInfiniteQuery
 * - Filtering (server-side and client-side)
 * - Rate limit handling
 *
 * Uses TanStack Query for:
 * - Automatic request deduplication
 * - Cache sharing between components (fixes pop-out window duplicate packets)
 * - Stale-while-revalidate pattern
 */

import { useCallback, useRef, useMemo, useState, useEffect } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { PacketLog, PacketFilters } from '../types/packet';
import { getPackets } from '../services/packetApi';

// Constants
const PACKET_FETCH_LIMIT = 100;
const POLL_INTERVAL_MS = 5000;

/**
 * Query key for packets - includes filters for proper cache isolation
 */
export const PACKETS_QUERY_KEY = ['packets'] as const;

/**
 * Build the full query key including filters
 */
export function getPacketsQueryKey(filters: PacketFilters) {
  return [...PACKETS_QUERY_KEY, filters] as const;
}

interface UsePacketsOptions {
  /** Whether the user has permission to view packets */
  canView: boolean;
  /** Server-side filters to apply */
  filters: PacketFilters;
  /** Whether to hide packets from own node (client-side filter) */
  hideOwnPackets: boolean;
  /** Own node number for filtering (hex nodeId converted to number) */
  ownNodeNum?: number;
}

interface UsePacketsResult {
  /** Filtered packets (after client-side hideOwnPackets filter) */
  packets: PacketLog[];
  /** Raw packets before client-side filtering */
  rawPackets: PacketLog[];
  /** Total packet count from server */
  total: number;
  /** Whether initial load is in progress */
  loading: boolean;
  /** Whether more packets are being loaded */
  loadingMore: boolean;
  /** Whether there are more packets to load */
  hasMore: boolean;
  /** Whether rate limit has been hit */
  rateLimitError: boolean;
  /** Load more packets (for infinite scroll) */
  loadMore: () => Promise<void>;
  /** Refresh packets from server */
  refresh: () => Promise<void>;
  /** Mark that user has scrolled (enables infinite scroll) */
  markUserScrolled: () => void;
  /** Check if should load more based on scroll position */
  shouldLoadMore: (lastVisibleIndex: number, threshold?: number) => boolean;
}

/**
 * Hook to manage packet data fetching and state
 *
 * Uses TanStack Query's useInfiniteQuery for automatic caching and
 * request deduplication. This fixes issues with duplicate packets
 * appearing in pop-out windows since cache is shared.
 *
 * @param options - Configuration options
 * @returns Packet data and controls
 *
 * @example
 * ```tsx
 * const {
 *   packets,
 *   loading,
 *   loadMore,
 *   hasMore,
 *   shouldLoadMore
 * } = usePackets({
 *   canView: true,
 *   filters: { portnum: 1 },
 *   hideOwnPackets: true,
 *   ownNodeNum: 123456
 * });
 * ```
 */
export function usePackets({ canView, filters, hideOwnPackets, ownNodeNum }: UsePacketsOptions): UsePacketsResult {
  const queryClient = useQueryClient();

  // Rate limit state (not handled by React Query)
  const [rateLimitError, setRateLimitError] = useState(false);
  const rateLimitResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Scroll tracking refs
  const lastLoadedRawLengthRef = useRef<number>(0);
  const userHasScrolledRef = useRef<boolean>(false);

  // Query key for this filter combination
  const queryKey = useMemo(() => getPacketsQueryKey(filters), [filters]);

  // Use infinite query for paginated data with polling
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading, refetch } = useInfiniteQuery({
    queryKey,
    queryFn: async ({ pageParam = 0 }) => {
      const response = await getPackets(pageParam, PACKET_FETCH_LIMIT, filters);
      return response;
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      // Calculate total loaded packets across all pages
      const totalLoaded = allPages.reduce((sum, page) => sum + page.packets.length, 0);

      // If last page has fewer packets than limit, there are no more
      if (lastPage.packets.length < PACKET_FETCH_LIMIT) {
        return undefined;
      }

      // Return the offset for the next page
      return totalLoaded;
    },
    enabled: canView,
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    staleTime: POLL_INTERVAL_MS - 1000, // Consider stale just before next poll
    gcTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
    refetchOnWindowFocus: false,
  });

  // Flatten all pages into raw packets array
  const rawPackets = useMemo(() => {
    if (!data?.pages) return [];
    return data.pages.flatMap(page => page.packets);
  }, [data?.pages]);

  // Get total from the most recent page response
  const total = useMemo(() => {
    if (!data?.pages || data.pages.length === 0) return 0;
    return data.pages[data.pages.length - 1].total;
  }, [data?.pages]);

  // Apply client-side "Hide Own Packets" filter
  const packets = useMemo(() => {
    if (hideOwnPackets && ownNodeNum) {
      return rawPackets.filter(packet => packet.from_node !== ownNodeNum);
    }
    return rawPackets;
  }, [rawPackets, hideOwnPackets, ownNodeNum]);

  // Reset scroll tracking when filters change (query is reset)
  useEffect(() => {
    userHasScrolledRef.current = false;
    lastLoadedRawLengthRef.current = 0;
  }, [queryKey]);

  // Load more packets (infinite scroll)
  const loadMore = useCallback(async () => {
    if (isFetchingNextPage || !hasNextPage || rateLimitError || !canView) return;

    try {
      await fetchNextPage();
      lastLoadedRawLengthRef.current = rawPackets.length + PACKET_FETCH_LIMIT;
    } catch (error) {
      console.error('Failed to load more packets:', error);

      // Check for rate limit error
      if (error instanceof Error && error.message.includes('Too many requests')) {
        setRateLimitError(true);

        if (rateLimitResetTimerRef.current) {
          clearTimeout(rateLimitResetTimerRef.current);
        }

        // Reset after 15 minutes
        rateLimitResetTimerRef.current = setTimeout(() => {
          setRateLimitError(false);
        }, 15 * 60 * 1000);
      }
    }
  }, [isFetchingNextPage, hasNextPage, rateLimitError, canView, fetchNextPage, rawPackets.length]);

  // Refresh packets (invalidate cache and refetch)
  const refresh = useCallback(async () => {
    // Invalidate and refetch
    await queryClient.invalidateQueries({ queryKey });
    await refetch();
  }, [queryClient, queryKey, refetch]);

  // Mark that user has scrolled (enables infinite scroll loading)
  const markUserScrolled = useCallback(() => {
    userHasScrolledRef.current = true;
  }, []);

  // Check if should load more based on scroll position
  const shouldLoadMore = useCallback(
    (lastVisibleIndex: number, threshold = 10): boolean => {
      if (lastVisibleIndex < 0) return false;

      // Don't load if we have raw packets but no filtered packets
      if (packets.length === 0 && rawPackets.length > 0) return false;

      const nearEnd = lastVisibleIndex >= packets.length - threshold;
      const alreadyLoadedFromHere = rawPackets.length > 0 && rawPackets.length === lastLoadedRawLengthRef.current;
      const enoughItemsDisplayed = packets.length >= threshold;
      const shouldRequireScroll = enoughItemsDisplayed && !userHasScrolledRef.current;
      const hasMorePages = hasNextPage ?? true;

      return (
        nearEnd &&
        hasMorePages &&
        !isFetchingNextPage &&
        !alreadyLoadedFromHere &&
        !shouldRequireScroll &&
        canView &&
        !rateLimitError
      );
    },
    [packets.length, rawPackets.length, hasNextPage, isFetchingNextPage, canView, rateLimitError]
  );

  // Cleanup rate limit timer on unmount
  useEffect(() => {
    return () => {
      if (rateLimitResetTimerRef.current) {
        clearTimeout(rateLimitResetTimerRef.current);
      }
    };
  }, []);

  return {
    packets,
    rawPackets,
    total,
    loading: isLoading,
    loadingMore: isFetchingNextPage,
    hasMore: hasNextPage ?? true,
    rateLimitError,
    loadMore,
    refresh,
    markUserScrolled,
    shouldLoadMore,
  };
}
