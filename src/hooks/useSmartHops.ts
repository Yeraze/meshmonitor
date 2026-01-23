/**
 * Smart Hops data fetching hook using TanStack Query
 *
 * Provides a hook for fetching smart hops statistics (min/max/avg hop counts)
 * with automatic caching, deduplication, and periodic refetching.
 */

import { useQuery } from '@tanstack/react-query';

/**
 * Smart hops data point from the backend
 */
export interface SmartHopsData {
  /** Unix timestamp in milliseconds (bucket start time) */
  timestamp: number;
  /** Minimum hop count in this time bucket */
  minHops: number;
  /** Maximum hop count in this time bucket */
  maxHops: number;
  /** Average hop count in this time bucket */
  avgHops: number;
}

/**
 * Response from smart hops API
 */
export interface SmartHopsResponse {
  success: boolean;
  data: SmartHopsData[];
}

/**
 * Options for useSmartHops hook
 */
interface UseSmartHopsOptions {
  /** Node ID to fetch statistics for */
  nodeId: string;
  /** Number of hours of historical data to fetch (default: 24) */
  hours?: number;
  /** Base URL for API requests (default: '') */
  baseUrl?: string;
  /** Whether to enable the query (default: true) */
  enabled?: boolean;
}

/**
 * Hook to fetch smart hops statistics for a specific node
 *
 * Uses TanStack Query for:
 * - Automatic request deduplication
 * - Caching with configurable stale time
 * - Automatic background refetching every 60 seconds
 * - Loading and error states
 *
 * @param options - Configuration options
 * @returns TanStack Query result with smart hops data
 *
 * @example
 * ```tsx
 * const { data, isLoading, error } = useSmartHops({
 *   nodeId: '!abcd1234',
 *   hours: 24
 * });
 * ```
 */
export function useSmartHops({
  nodeId,
  hours = 24,
  baseUrl = '',
  enabled = true,
}: UseSmartHopsOptions) {
  return useQuery({
    queryKey: ['smartHops', nodeId, hours],
    queryFn: async (): Promise<SmartHopsData[]> => {
      const response = await fetch(`${baseUrl}/api/telemetry/${nodeId}/smarthops?hours=${hours}`);

      if (!response.ok) {
        throw new Error(`Failed to fetch smart hops: ${response.status} ${response.statusText}`);
      }

      const result: SmartHopsResponse = await response.json();
      return result.data;
    },
    enabled: enabled && !!nodeId,
    refetchInterval: 60000, // Refetch every 60 seconds
    staleTime: 55000, // Data considered fresh for 55 seconds
    gcTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
    refetchOnWindowFocus: false,
  });
}
