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

import { useCallback, useMemo } from 'react';
import { PacketLog, PacketFilters } from '../types/packet';
import { getPackets } from '../services/packetApi';
import { usePagedPackets } from './usePagedPackets';

// Constants
const PACKET_FETCH_LIMIT = 100;
const POLL_INTERVAL_MS = 5000;

/**
 * Query key for packets - includes filters and sourceId for proper cache isolation
 */
export const PACKETS_QUERY_KEY = ['packets'] as const;

/**
 * Build the full query key including filters and sourceId
 */
export function getPacketsQueryKey(filters: PacketFilters, sourceId?: string | null) {
  return [...PACKETS_QUERY_KEY, sourceId ?? 'all', filters] as const;
}

interface UsePacketsOptions {
  /** Whether the user has permission to view packets */
  canView: boolean;
  /** Server-side filters to apply */
  filters: PacketFilters;
  /** Whether to hide our own packets heard back (client-side filter; TX rows are kept) */
  hideOwnPackets: boolean;
  /** Own node number for filtering (hex nodeId converted to number) */
  ownNodeNum?: number;
  /** Source ID for multi-source filtering */
  sourceId?: string | null;
}

/**
 * True for a packet we sent that the radio heard back: an RX row whose sender
 * is our own node (rebroadcast over RF, or returned via MQTT/UDP).
 *
 * A row with `direction === 'tx'` is the send itself, logged by
 * `logOutgoingPacket` with `from_node` = our node. It is never an echo, so
 * "Hide Own Packets" must keep it. Matching on `from_node` alone hid every TX
 * row in the per-source monitor (#5579).
 *
 * `from_node` is coerced because PostgreSQL/MySQL return BIGINT columns as
 * strings on some paths.
 */
export function isOwnPacketEcho(packet: PacketLog, ownNodeNum: number): boolean {
  if (packet.direction === 'tx') return false;
  return Number(packet.from_node) === ownNodeNum;
}

interface UsePacketsResult {
  /** Filtered packets (after client-side hideOwnPackets filter) */
  packets: PacketLog[];
  /** Raw packets before client-side filtering */
  rawPackets: PacketLog[];
  /** Loaded rows the client-side hideOwnPackets filter removed */
  hiddenCount: number;
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
 *   hasMore
 * } = usePackets({
 *   canView: true,
 *   filters: { portnum: 1 },
 *   hideOwnPackets: true,
 *   ownNodeNum: 123456
 * });
 * ```
 */
export function usePackets({ canView, filters, hideOwnPackets, ownNodeNum, sourceId }: UsePacketsOptions): UsePacketsResult {
  // Merge sourceId into filters for API calls
  const effectiveFilters = useMemo(() => {
    if (sourceId) return { ...filters, sourceId };
    return filters;
  }, [filters, sourceId]);

  const queryKey = useMemo(() => getPacketsQueryKey(filters, sourceId), [filters, sourceId]);

  const fetchPage = useCallback(
    (pageParam: number | string | null, pageSize: number) =>
      getPackets(Number(pageParam ?? 0), pageSize, effectiveFilters),
    [effectiveFilters],
  );

  const paged = usePagedPackets<PacketLog>({
    queryKey,
    canView,
    pageSize: PACKET_FETCH_LIMIT,
    paging: 'offset',
    fetchPage,
    pollIntervalMs: POLL_INTERVAL_MS,
  });

  const rawPackets = paged.packets;

  // Apply client-side "Hide Own Packets" filter
  const packets = useMemo(() => {
    if (hideOwnPackets && ownNodeNum) {
      return rawPackets.filter(packet => !isOwnPacketEcho(packet, ownNodeNum));
    }
    return rawPackets;
  }, [rawPackets, hideOwnPackets, ownNodeNum]);

  // Rows the client filter removed from the loaded set. The panel shows this
  // so a filter that lives in a collapsed drawer cannot hide rows unseen (#5579).
  const hiddenCount = rawPackets.length - packets.length;

  return {
    packets,
    rawPackets,
    hiddenCount,
    total: paged.total,
    loading: paged.loading,
    loadingMore: paged.loadingMore,
    hasMore: paged.hasMore,
    rateLimitError: paged.rateLimitError,
    loadMore: paged.loadMore,
    refresh: paged.refresh,
  };
}
