/**
 * Hook for managing packet data fetching and state
 *
 * Provides packet data management for PacketMonitorPanel including:
 * - Initial fetch and polling
 * - Infinite scroll/load more
 * - Filtering (server-side and client-side)
 * - Rate limit handling
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { PacketLog, PacketFilters } from '../types/packet';
import { getPackets } from '../services/packetApi';

// Constants
const PACKET_FETCH_LIMIT = 100;
const POLL_INTERVAL_MS = 5000;

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
export function usePackets({
  canView,
  filters,
  hideOwnPackets,
  ownNodeNum,
}: UsePacketsOptions): UsePacketsResult {
  const [rawPackets, setRawPackets] = useState<PacketLog[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [rateLimitError, setRateLimitError] = useState(false);

  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const rateLimitResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLoadedRawLengthRef = useRef<number>(0);
  const userHasScrolledRef = useRef<boolean>(false);

  // Apply client-side "Hide Own Packets" filter
  const packets = useMemo(() => {
    if (hideOwnPackets && ownNodeNum) {
      return rawPackets.filter(packet => packet.from_node !== ownNodeNum);
    }
    return rawPackets;
  }, [rawPackets, hideOwnPackets, ownNodeNum]);

  // Reset scroll tracking when raw packets are cleared
  useEffect(() => {
    if (rawPackets.length === 0) {
      userHasScrolledRef.current = false;
      lastLoadedRawLengthRef.current = 0;
    }
  }, [rawPackets.length]);

  // Fetch packets (initial load or refresh from polling)
  const fetchPackets = useCallback(async () => {
    if (!canView) return;

    try {
      const currentPacketCount = rawPackets.length;
      const isInitialLoad = currentPacketCount === 0;

      const response = await getPackets(0, PACKET_FETCH_LIMIT, filters);

      // Only update if initial load OR if there are new packets
      if (isInitialLoad || response.packets[0]?.id !== rawPackets[0]?.id) {
        if (!isInitialLoad && currentPacketCount > PACKET_FETCH_LIMIT) {
          // Preserve existing packets beyond the first batch when polling
          const newPacketIds = new Set(response.packets.map(p => p.id));
          const oldPacketsWithoutDuplicates = rawPackets.filter(p => !newPacketIds.has(p.id));
          setRawPackets([...response.packets, ...oldPacketsWithoutDuplicates]);
        } else {
          setRawPackets(response.packets);
          setHasMore(response.packets.length >= PACKET_FETCH_LIMIT);
        }
        setTotal(response.total);
      }

      setLoading(false);
    } catch (error) {
      console.error('Failed to fetch packets:', error);
      setLoading(false);
    }
  }, [canView, filters, rawPackets]);

  // Load more packets (infinite scroll)
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || rateLimitError || !canView) return;

    setLoadingMore(true);
    try {
      const response = await getPackets(rawPackets.length, PACKET_FETCH_LIMIT, filters);

      if (response.packets.length === 0) {
        setHasMore(false);
      } else {
        setRawPackets(prev => {
          const newLength = prev.length + response.packets.length;
          lastLoadedRawLengthRef.current = newLength;
          return [...prev, ...response.packets];
        });
        setTotal(response.total);
      }
    } catch (error) {
      console.error('Failed to load more packets:', error);

      // Check for rate limit error
      if (error instanceof Error && error.message.includes('Too many requests')) {
        setRateLimitError(true);
        setHasMore(false);

        if (rateLimitResetTimerRef.current) {
          clearTimeout(rateLimitResetTimerRef.current);
        }

        // Reset after 15 minutes
        rateLimitResetTimerRef.current = setTimeout(() => {
          setRateLimitError(false);
          setHasMore(true);
        }, 15 * 60 * 1000);
      }
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, rateLimitError, canView, rawPackets.length, filters]);

  // Mark that user has scrolled (enables infinite scroll loading)
  const markUserScrolled = useCallback(() => {
    userHasScrolledRef.current = true;
  }, []);

  // Check if should load more based on scroll position
  const shouldLoadMore = useCallback((lastVisibleIndex: number, threshold = 10): boolean => {
    if (lastVisibleIndex < 0) return false;

    // Don't load if we have raw packets but no filtered packets
    if (packets.length === 0 && rawPackets.length > 0) return false;

    const nearEnd = lastVisibleIndex >= packets.length - threshold;
    const alreadyLoadedFromHere = rawPackets.length > 0 && rawPackets.length === lastLoadedRawLengthRef.current;
    const enoughItemsDisplayed = packets.length >= threshold;
    const shouldRequireScroll = enoughItemsDisplayed && !userHasScrolledRef.current;

    return nearEnd && hasMore && !loadingMore && !alreadyLoadedFromHere && !shouldRequireScroll && canView;
  }, [packets.length, rawPackets.length, hasMore, loadingMore, canView]);

  // Initial fetch and polling
  useEffect(() => {
    if (!canView) return;

    // Reset state when filters change
    setRawPackets([]);
    setLoading(true);
    setHasMore(true);
    lastLoadedRawLengthRef.current = 0;
    userHasScrolledRef.current = false;

    fetchPackets();

    pollIntervalRef.current = setInterval(fetchPackets, POLL_INTERVAL_MS);

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canView, JSON.stringify(filters)]); // fetchPackets not in deps to avoid infinite loop

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
      if (rateLimitResetTimerRef.current) {
        clearTimeout(rateLimitResetTimerRef.current);
      }
    };
  }, []);

  return {
    packets,
    rawPackets,
    total,
    loading,
    loadingMore,
    hasMore,
    rateLimitError,
    loadMore,
    refresh: fetchPackets,
    markUserScrolled,
    shouldLoadMore,
  };
}
