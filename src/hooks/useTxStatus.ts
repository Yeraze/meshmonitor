/**
 * TX Status hook using TanStack Query
 *
 * Provides a hook for fetching device TX (transmit) status
 * with automatic caching and periodic refetching.
 * Used to display a warning banner when TX is disabled on the device.
 */

import { useQuery } from '@tanstack/react-query';

/**
 * TX Status response from the backend
 */
export interface TxStatusData {
  /** Whether TX is enabled on the device */
  txEnabled: boolean;
}

/**
 * Options for useTxStatus hook
 */
interface UseTxStatusOptions {
  /** Base URL for API requests (default: '') */
  baseUrl?: string;
  /** Whether to enable the query (default: true) */
  enabled?: boolean;
  /** Refetch interval in milliseconds (default: 30000) */
  refetchInterval?: number;
}

/**
 * Hook to fetch device TX (transmit) status
 *
 * Uses TanStack Query for:
 * - Automatic request deduplication (prevents duplicate in-flight requests)
 * - Caching with configurable stale time
 * - Automatic background refetching
 * - Loading and error states
 *
 * This hook is useful for:
 * - Displaying a warning when TX is disabled
 * - Monitoring device transmit capability
 *
 * @param options - Configuration options
 * @returns TanStack Query result with TX status data plus computed isTxDisabled flag
 *
 * @example
 * ```tsx
 * const { isTxDisabled } = useTxStatus({ baseUrl });
 *
 * {isTxDisabled && (
 *   <div className="warning-banner">TX is disabled on this device</div>
 * )}
 * ```
 */
export function useTxStatus({
  baseUrl = '',
  enabled = true,
  refetchInterval = 30000,
}: UseTxStatusOptions = {}) {
  const query = useQuery({
    queryKey: ['txStatus', baseUrl],
    queryFn: async (): Promise<TxStatusData> => {
      const response = await fetch(`${baseUrl}/api/device/tx-status`, {
        credentials: 'include',
      });

      if (!response.ok) {
        throw new Error(`TX status check failed: ${response.status} ${response.statusText}`);
      }

      return response.json();
    },
    enabled,
    refetchInterval,
    staleTime: refetchInterval - 5000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  return {
    ...query,
    /** Whether TX is disabled (inverse of txEnabled for convenience) */
    isTxDisabled: query.data ? !query.data.txEnabled : false,
  };
}
