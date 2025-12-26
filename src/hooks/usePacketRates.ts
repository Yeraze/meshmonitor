/**
 * Packet rate data fetching hook using TanStack Query
 *
 * Provides a hook for fetching packet rate statistics (packets per minute)
 * with automatic caching, deduplication, and periodic refetching.
 */

import { useQuery } from '@tanstack/react-query';

/**
 * Rate data point from the backend
 */
export interface PacketRateData {
  /** Unix timestamp in milliseconds */
  timestamp: number;
  /** Rate in packets per minute */
  ratePerMinute: number;
}

/**
 * Response from packet rates API
 */
export interface PacketRatesResponse {
  numPacketsRx: PacketRateData[];
  numPacketsRxBad: PacketRateData[];
  numRxDupe: PacketRateData[];
  numPacketsTx: PacketRateData[];
  numTxDropped: PacketRateData[];
  numTxRelay: PacketRateData[];
  numTxRelayCanceled: PacketRateData[];
}

/**
 * Options for usePacketRates hook
 */
interface UsePacketRatesOptions {
  /** Node ID to fetch rates for */
  nodeId: string;
  /** Number of hours of historical data to fetch (default: 24) */
  hours?: number;
  /** Base URL for API requests (default: '') */
  baseUrl?: string;
  /** Whether to enable the query (default: true) */
  enabled?: boolean;
}

/**
 * Hook to fetch packet rate statistics for a specific node
 *
 * Uses TanStack Query for:
 * - Automatic request deduplication
 * - Caching with configurable stale time
 * - Automatic background refetching every 60 seconds
 * - Loading and error states
 *
 * @param options - Configuration options
 * @returns TanStack Query result with packet rate data
 *
 * @example
 * ```tsx
 * const { data, isLoading, error } = usePacketRates({
 *   nodeId: '!abcd1234',
 *   hours: 24
 * });
 * ```
 */
export function usePacketRates({
  nodeId,
  hours = 24,
  baseUrl = '',
  enabled = true,
}: UsePacketRatesOptions) {
  return useQuery({
    queryKey: ['packetRates', nodeId, hours],
    queryFn: async (): Promise<PacketRatesResponse> => {
      const response = await fetch(`${baseUrl}/api/telemetry/${nodeId}/rates?hours=${hours}`);

      if (!response.ok) {
        throw new Error(`Failed to fetch packet rates: ${response.status} ${response.statusText}`);
      }

      return response.json();
    },
    enabled: enabled && !!nodeId,
    refetchInterval: 60000, // Refetch every 60 seconds (matches LocalStats polling)
    staleTime: 55000, // Data considered fresh for 55 seconds
    gcTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
    refetchOnWindowFocus: false,
  });
}
