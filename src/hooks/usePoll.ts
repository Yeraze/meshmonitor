/**
 * Main polling hook using TanStack Query
 *
 * Provides consolidated polling for nodes, messages, channels, config and connection status.
 * Replaces the manual setInterval-based polling in App.tsx.
 *
 * ## Usage Guidelines
 *
 * **For React components**: Use the convenience hooks from `useServerData.ts`:
 * - `useNodes()` - Get nodes array
 * - `useChannels()` - Get channels array
 * - `useConnectionInfo()` - Get connection status
 * - `useTelemetryNodes()` - Get telemetry availability
 * - `useDeviceConfig()` - Get device configuration
 *
 * **For callbacks/handlers outside React**: Use the cache helpers:
 * - `getNodesFromCache(queryClient)` - Get nodes without subscribing
 * - `getChannelsFromCache(queryClient)` - Get channels without subscribing
 * - `getCurrentNodeIdFromCache(queryClient)` - Get current node ID
 *
 * **Direct query key access**: Use `POLL_QUERY_KEY` only when:
 * - Invalidating the cache manually: `queryClient.invalidateQueries({ queryKey: POLL_QUERY_KEY })`
 * - Setting up query observers outside components
 * - Custom cache manipulation scenarios
 */

import { useQuery } from '@tanstack/react-query';
import { useCsrfFetch } from './useCsrfFetch';
import type { DeviceInfo, Channel } from '../types/device';

/**
 * Connection status from the server
 */
export interface ConnectionStatus {
  connected: boolean;
  nodeResponsive: boolean;
  configuring: boolean;
  userDisconnected: boolean;
  nodeIp?: string;
}

/**
 * Telemetry availability by node
 */
export interface TelemetryNodes {
  /** Node IDs that have any telemetry data */
  nodes: string[];
  /** Node IDs that have weather telemetry */
  weather: string[];
  /** Node IDs that have estimated position */
  estimatedPosition: string[];
  /** Node IDs that have PKC (public key cryptography) */
  pkc: string[];
}

/**
 * Unread message counts
 */
export interface UnreadCounts {
  /** Unread count per channel */
  channels?: { [channelId: number]: number };
  /** Unread count per DM conversation (by node ID) */
  directMessages?: { [nodeId: string]: number };
}

/**
 * Basic configuration from the server
 */
export interface PollConfig {
  meshtasticNodeIp?: string;
  meshtasticTcpPort?: number;
  meshtasticUseTls?: boolean;
  baseUrl?: string;
  deviceMetadata?: {
    firmwareVersion?: string;
    rebootCount?: number;
  };
  localNodeInfo?: {
    nodeId: string;
    longName?: string;
    shortName?: string;
  };
}

/**
 * Device configuration (requires configuration:read permission)
 */
export interface DeviceConfig {
  basic?: {
    nodeId?: string;
    nodeAddress?: string;
    [key: string]: unknown;
  };
  lora?: {
    modemPreset?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Raw message from the server (before timestamp conversion)
 */
export interface RawMessage {
  id: string;
  from: string;
  to: string;
  fromNodeId: string;
  toNodeId: string;
  text: string;
  channel: number;
  portnum?: number;
  timestamp: string | number;
  acknowledged?: boolean;
  ackFailed?: boolean;
  isLocalMessage?: boolean;
  hopStart?: number;
  hopLimit?: number;
  replyId?: number;
  emoji?: number;
  deliveryState?: string;
  wantAck?: boolean;
  routingErrorReceived?: boolean;
  requestId?: number;
}

/**
 * Complete poll response from the server
 */
export interface PollData {
  connection?: ConnectionStatus;
  nodes?: DeviceInfo[];
  messages?: RawMessage[];
  unreadCounts?: UnreadCounts;
  channels?: Channel[];
  telemetryNodes?: TelemetryNodes;
  config?: PollConfig;
  deviceConfig?: DeviceConfig;
}

/**
 * Options for usePoll hook
 */
interface UsePollOptions {
  /** Base URL for API requests (default: '') */
  baseUrl?: string;
  /** Poll interval in milliseconds (default: 5000) */
  pollInterval?: number;
  /** Whether polling is enabled (default: true) */
  enabled?: boolean;
}

/**
 * Query key for the poll endpoint.
 *
 * Use this when you need to:
 * - Invalidate the poll cache: `queryClient.invalidateQueries({ queryKey: POLL_QUERY_KEY })`
 * - Manually refetch: `queryClient.refetchQueries({ queryKey: POLL_QUERY_KEY })`
 * - Set up custom query observers
 *
 * For accessing cached data, prefer the helper functions in useServerData.ts:
 * `getNodesFromCache()`, `getChannelsFromCache()`, `getCurrentNodeIdFromCache()`
 */
export const POLL_QUERY_KEY = ['poll'] as const;

/**
 * Hook to poll the consolidated /api/poll endpoint
 *
 * Uses TanStack Query for automatic request deduplication, caching, and retry.
 * The poll endpoint returns nodes, messages, channels, config, and connection status
 * in a single request to reduce network overhead.
 *
 * @param options - Configuration options
 * @returns TanStack Query result with PollData
 *
 * @example
 * ```tsx
 * const { data, isLoading, error } = usePoll({
 *   baseUrl: '',
 *   pollInterval: 5000,
 *   enabled: connectionStatus === 'connected'
 * });
 *
 * // Access individual data
 * const nodes = data?.nodes ?? [];
 * const messages = data?.messages ?? [];
 * const connection = data?.connection;
 *
 * // Handle errors
 * if (error) {
 *   console.error('Poll failed:', error.message);
 * }
 * ```
 */
export function usePoll({ baseUrl = '', pollInterval = 5000, enabled = true }: UsePollOptions = {}) {
  const authFetch = useCsrfFetch();

  return useQuery({
    queryKey: POLL_QUERY_KEY,
    queryFn: async (): Promise<PollData> => {
      const response = await authFetch(`${baseUrl}/api/poll`);

      if (!response.ok) {
        throw new Error(`Poll request failed: ${response.status}`);
      }

      return response.json();
    },
    enabled,
    refetchInterval: pollInterval,
    staleTime: pollInterval - 1000, // Consider stale just before next poll
    gcTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
    refetchOnWindowFocus: false,
  });
}
