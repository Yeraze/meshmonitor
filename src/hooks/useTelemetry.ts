/**
 * Telemetry data fetching hooks using TanStack Query
 *
 * Provides hooks for fetching telemetry and solar estimate data
 * with automatic caching, deduplication, and periodic refetching.
 * Replaces manual setInterval polling with TanStack Query's built-in
 * refetch capabilities.
 */

import { useQuery } from '@tanstack/react-query';

/**
 * Telemetry data point from the backend
 */
export interface TelemetryData {
  /** Unique identifier for this telemetry record */
  id?: number;
  /** Node ID in format !xxxxxxxx */
  nodeId: string;
  /** Numeric node identifier */
  nodeNum: number;
  /** Type of telemetry (e.g., 'batteryLevel', 'temperature', 'voltage') */
  telemetryType: string;
  /** Unix timestamp in milliseconds */
  timestamp: number;
  /** Telemetry value */
  value: number;
  /** Unit of measurement (optional) */
  unit?: string;
  /** Record creation timestamp */
  createdAt: number;
}

/**
 * Solar power estimate data point
 */
interface SolarEstimate {
  /** Unix timestamp in seconds */
  timestamp: number;
  /** Estimated watt-hours of solar power */
  wattHours: number;
}

/**
 * Response from solar estimates API
 */
interface SolarEstimatesResponse {
  estimates: SolarEstimate[];
}

/**
 * Options for useTelemetry hook
 */
interface UseTelemetryOptions {
  /** Node ID to fetch telemetry for */
  nodeId: string;
  /** Number of hours of historical data to fetch (default: 24) */
  hours?: number;
  /** Base URL for API requests (default: '') */
  baseUrl?: string;
  /** Whether to enable the query (default: true) */
  enabled?: boolean;
}

/**
 * Hook to fetch telemetry data for a specific node
 *
 * Uses TanStack Query for:
 * - Automatic request deduplication (prevents duplicate in-flight requests)
 * - Caching with configurable stale time
 * - Automatic background refetching every 30 seconds
 * - Loading and error states
 *
 * @param options - Configuration options
 * @returns TanStack Query result with telemetry data
 *
 * @example
 * ```tsx
 * const { data, isLoading, error } = useTelemetry({
 *   nodeId: '!abcd1234',
 *   hours: 24
 * });
 * ```
 */
export function useTelemetry({ nodeId, hours = 24, baseUrl = '', enabled = true }: UseTelemetryOptions) {
  return useQuery({
    queryKey: ['telemetry', nodeId, hours],
    queryFn: async (): Promise<TelemetryData[]> => {
      const response = await fetch(`${baseUrl}/api/telemetry/${nodeId}?hours=${hours}`);

      if (!response.ok) {
        throw new Error(`Failed to fetch telemetry: ${response.status} ${response.statusText}`);
      }

      return response.json();
    },
    enabled: enabled && !!nodeId,
    refetchInterval: 30000, // Refetch every 30 seconds
    staleTime: 25000, // Data considered fresh for 25 seconds
    gcTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
    refetchOnWindowFocus: false,
  });
}

/**
 * Options for useSolarEstimates hook
 */
interface UseSolarEstimatesOptions {
  /** Base URL for API requests (default: '') */
  baseUrl?: string;
  /** Start timestamp in Unix seconds */
  startTimestamp?: number;
  /** End timestamp in Unix seconds */
  endTimestamp?: number;
  /** Whether to enable the query (default: true) */
  enabled?: boolean;
}

/**
 * Hook to fetch solar power estimates within a time range
 *
 * Uses TanStack Query for automatic caching and periodic refetching.
 * Returns an empty Map if solar monitoring is not configured.
 *
 * @param options - Configuration options
 * @returns TanStack Query result with solar estimates as Map<timestamp_ms, wattHours>
 *
 * @example
 * ```tsx
 * const { data: solarEstimates } = useSolarEstimates({
 *   startTimestamp: Math.floor(Date.now() / 1000) - 86400,
 *   endTimestamp: Math.floor(Date.now() / 1000)
 * });
 * ```
 */
export function useSolarEstimates({
  baseUrl = '',
  startTimestamp,
  endTimestamp,
  enabled = true,
}: UseSolarEstimatesOptions) {
  return useQuery({
    queryKey: ['solarEstimates', startTimestamp, endTimestamp],
    queryFn: async (): Promise<Map<number, number>> => {
      const response = await fetch(`${baseUrl}/api/solar/estimates/range?start=${startTimestamp}&end=${endTimestamp}`);

      if (!response.ok) {
        // Return empty map if solar monitoring not configured
        return new Map();
      }

      const data: SolarEstimatesResponse = await response.json();

      const estimatesMap = new Map<number, number>();
      if (data.estimates && data.estimates.length > 0) {
        data.estimates.forEach(est => {
          // Convert Unix seconds to milliseconds for consistency with telemetry timestamps
          estimatesMap.set(est.timestamp * 1000, est.wattHours);
        });
      }

      return estimatesMap;
    },
    enabled: enabled && !!startTimestamp && !!endTimestamp,
    refetchInterval: 60000, // Refetch every 60 seconds
    staleTime: 55000, // Data considered fresh for 55 seconds
    gcTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
    refetchOnWindowFocus: false,
  });
}

/**
 * Options for useSolarEstimatesLatest hook
 */
interface UseSolarEstimatesLatestOptions {
  /** Base URL for API requests (default: '') */
  baseUrl?: string;
  /** Maximum number of estimates to fetch (default: 500) */
  limit?: number;
  /** Whether to enable the query (default: true) */
  enabled?: boolean;
}

/**
 * Hook to fetch latest solar power estimates (no time range)
 *
 * Uses TanStack Query for automatic caching and periodic refetching.
 * Returns an empty Map if solar monitoring is not configured.
 * This is useful for the Dashboard which shows all available solar data.
 *
 * @param options - Configuration options
 * @returns TanStack Query result with solar estimates as Map<timestamp_ms, wattHours>
 */
export function useSolarEstimatesLatest({
  baseUrl = '',
  limit = 500,
  enabled = true,
}: UseSolarEstimatesLatestOptions = {}) {
  return useQuery({
    queryKey: ['solarEstimatesLatest', limit],
    queryFn: async (): Promise<Map<number, number>> => {
      const response = await fetch(`${baseUrl}/api/solar/estimates?limit=${limit}`);

      if (!response.ok) {
        // Return empty map if solar monitoring not configured
        return new Map();
      }

      const data: SolarEstimatesResponse = await response.json();

      const estimatesMap = new Map<number, number>();
      if (data.estimates && data.estimates.length > 0) {
        data.estimates.forEach(est => {
          // Convert Unix seconds to milliseconds for consistency with telemetry timestamps
          estimatesMap.set(est.timestamp * 1000, est.wattHours);
        });
      }

      return estimatesMap;
    },
    enabled,
    refetchInterval: 300000, // Refetch every 5 minutes (solar data changes slowly)
    staleTime: 290000, // Data considered fresh for ~5 minutes
    gcTime: 10 * 60 * 1000, // Keep in cache for 10 minutes
    refetchOnWindowFocus: false,
  });
}
