/**
 * Link Quality data fetching hook using TanStack Query
 *
 * Provides a hook for fetching link quality history
 * with automatic caching, deduplication, and periodic refetching.
 */

import { useQuery } from '@tanstack/react-query';

/**
 * Link quality data point from the backend
 */
export interface LinkQualityData {
  /** Unix timestamp in milliseconds */
  timestamp: number;
  /** Link quality value (0-10, where 10 is excellent) */
  quality: number;
}

/**
 * Response from link quality API
 */
export interface LinkQualityResponse {
  success: boolean;
  data: LinkQualityData[];
}

/**
 * Options for useLinkQuality hook
 */
interface UseLinkQualityOptions {
  /** Node ID to fetch history for */
  nodeId: string;
  /** Number of hours of historical data to fetch (default: 24) */
  hours?: number;
  /** Base URL for API requests (default: '') */
  baseUrl?: string;
  /** Whether to enable the query (default: true) */
  enabled?: boolean;
}

/**
 * Hook to fetch link quality history for a specific node
 *
 * Uses TanStack Query for:
 * - Automatic request deduplication
 * - Caching with configurable stale time
 * - Automatic background refetching every 60 seconds
 * - Loading and error states
 *
 * @param options - Configuration options
 * @returns TanStack Query result with link quality data
 *
 * @example
 * ```tsx
 * const { data, isLoading, error } = useLinkQuality({
 *   nodeId: '!abcd1234',
 *   hours: 24
 * });
 * ```
 */
export function useLinkQuality({
  nodeId,
  hours = 24,
  baseUrl = '',
  enabled = true,
}: UseLinkQualityOptions) {
  return useQuery({
    queryKey: ['linkQuality', nodeId, hours],
    queryFn: async (): Promise<LinkQualityData[]> => {
      const response = await fetch(`${baseUrl}/api/telemetry/${nodeId}/linkquality?hours=${hours}`);

      if (!response.ok) {
        throw new Error(`Failed to fetch link quality: ${response.status} ${response.statusText}`);
      }

      const result: LinkQualityResponse = await response.json();
      return result.data;
    },
    enabled: enabled && !!nodeId,
    refetchInterval: 60000, // Refetch every 60 seconds
    staleTime: 55000, // Data considered fresh for 55 seconds
    gcTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
    refetchOnWindowFocus: false,
  });
}
