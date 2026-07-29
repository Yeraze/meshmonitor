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
  /** Whether the radio itself is TX-enabled (`lora.txEnabled`) */
  txEnabled: boolean;
  /**
   * Whether the device broadcasts its outgoing packets over local-LAN UDP
   * (`network.enabledProtocols & UDP_BROADCAST`). A TX-disabled node with this
   * on still reaches the mesh, because a LAN peer relays for it (#4394).
   * Absent on older servers.
   */
  udpRelayEnabled?: boolean;
  /**
   * Whether sends have any path onto the mesh (`txEnabled || udpRelayEnabled`).
   * Absent on older servers — callers fall back to `txEnabled`.
   */
  canTransmit?: boolean;
}

/**
 * Options for useTxStatus hook
 */
interface UseTxStatusOptions {
  /** Base URL for API requests (default: '') */
  baseUrl?: string;
  /** Source ID for multi-source deployments */
  sourceId?: string | null;
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
  sourceId,
  enabled = true,
  refetchInterval = 30000,
}: UseTxStatusOptions = {}) {
  const query = useQuery({
    queryKey: ['txStatus', baseUrl, sourceId],
    queryFn: async (): Promise<TxStatusData> => {
      const url = sourceId
        ? `${baseUrl}/api/device/tx-status?sourceId=${encodeURIComponent(sourceId)}`
        : `${baseUrl}/api/device/tx-status`;
      const response = await fetch(url, {
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

  const data = query.data;
  // A source with the radio TX-disabled but UDP Broadcast on can still put
  // packets on the mesh through a LAN peer, so it must NOT be send-gated (#4394).
  // `canTransmit` is absent on older servers — fall back to the radio flag.
  const canTransmit = data ? (data.canTransmit ?? data.txEnabled) : true;

  return {
    ...query,
    /** Whether sends are blocked entirely (no radio TX and no UDP relay path) */
    isTxDisabled: data ? !canTransmit : false,
    /**
     * Whether the radio is TX-disabled but UDP Broadcast relays sends anyway.
     * Sends are allowed; the UI should say "relayed via UDP broadcast", not
     * "cannot send".
     */
    isUdpRelay: data ? data.txEnabled === false && data.udpRelayEnabled === true : false,
  };
}
