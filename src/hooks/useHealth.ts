/**
 * Health endpoint hook using TanStack Query
 *
 * Provides a hook for fetching server health/version data
 * with automatic caching and periodic refetching.
 * Used for monitoring backend version changes (e.g., after auto-upgrade).
 */

import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { logger } from '../utils/logger';

/**
 * Health response from the backend
 */
export interface HealthData {
  /** Server status (always 'ok' if reachable) */
  status: 'ok';
  /** Server version from package.json */
  version: string;
  /** Server uptime in milliseconds since start */
  uptime: number;
}

/**
 * Options for useHealth hook
 */
interface UseHealthOptions {
  /** Base URL for API requests (default: '') */
  baseUrl?: string;
  /** Whether to enable the query (default: true) */
  enabled?: boolean;
  /** Refetch interval in milliseconds (default: 30000) */
  refetchInterval?: number;
  /** Whether to auto-reload on version change (default: false) */
  reloadOnVersionChange?: boolean;
}

/**
 * Hook to fetch server health and version data
 *
 * Uses TanStack Query for:
 * - Automatic request deduplication (prevents duplicate in-flight requests)
 * - Caching with configurable stale time
 * - Automatic background refetching
 * - Loading and error states
 *
 * This hook is useful for:
 * - Monitoring server availability
 * - Detecting version changes after auto-upgrade
 * - Displaying server uptime
 *
 * @param options - Configuration options
 * @returns TanStack Query result with health data plus initialVersion
 *
 * @example
 * ```tsx
 * // Basic usage
 * const { data, isLoading, error } = useHealth();
 *
 * // With auto-reload on version change
 * const { data } = useHealth({ reloadOnVersionChange: true });
 * ```
 */
export function useHealth({
  baseUrl = '',
  enabled = true,
  refetchInterval = 30000,
  reloadOnVersionChange = false,
}: UseHealthOptions = {}) {
  const initialVersionRef = useRef<string | null>(null);

  const query = useQuery({
    queryKey: ['health', baseUrl],
    queryFn: async (): Promise<HealthData> => {
      const response = await fetch(`${baseUrl}/api/health`);

      if (!response.ok) {
        throw new Error(`Health check failed: ${response.status} ${response.statusText}`);
      }

      return response.json();
    },
    enabled,
    refetchInterval,
    staleTime: refetchInterval - 5000, // Data considered fresh slightly less than refetch interval
    gcTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
    refetchOnWindowFocus: false,
    retry: 1, // Only retry once on failure
  });

  // Track version changes and optionally reload
  useEffect(() => {
    if (!query.data?.version) return;

    if (initialVersionRef.current === null) {
      // First successful fetch - store the initial version
      initialVersionRef.current = query.data.version;
      logger.info(`Initial backend version: ${query.data.version}`);
    } else if (initialVersionRef.current !== query.data.version) {
      // Version changed - backend was upgraded
      logger.info(
        `Backend version changed from ${initialVersionRef.current} to ${query.data.version}` +
          (reloadOnVersionChange ? ' - reloading page' : '')
      );
      if (reloadOnVersionChange) {
        window.location.reload();
      }
    }
  }, [query.data?.version, reloadOnVersionChange]);

  return {
    ...query,
    /** The initial version detected on first successful fetch */
    initialVersion: initialVersionRef.current,
  };
}
