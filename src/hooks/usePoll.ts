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
import type { DeviceInfo, Channel, LocalNodeInfo } from '../types/device';
import { appBasename } from '../init';
import { useWebSocketConnected } from '../contexts/WebSocketContext';

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
  localNodeInfo?: LocalNodeInfo;
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
 * Traceroute data from the poll endpoint
 */
export interface PollTraceroute {
  id?: number;
  fromNodeNum: number;
  toNodeNum: number;
  fromNodeId: string;
  toNodeId: string;
  route: string;
  routeBack: string;
  snrTowards: string;
  snrBack: string;
  routePositions?: string; // JSON: { [nodeNum]: { lat, lng, alt? } } - position snapshot at traceroute time
  timestamp: number;
  createdAt: number;
  hopCount: number;
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
  relayNode?: number;
  replyId?: number;
  emoji?: number;
  deliveryState?: string;
  wantAck?: boolean;
  routingErrorReceived?: boolean;
  requestId?: number;
  rxSnr?: number;
  rxRssi?: number;
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
  traceroutes?: PollTraceroute[];
}

/**
 * Options for usePoll hook
 */
interface UsePollOptions {
  /** Base URL for API requests (default: appBasename from init.ts) */
  baseUrl?: string;
  /** Poll interval in milliseconds (default: 5000, or 30000 when WebSocket connected) */
  pollInterval?: number;
  /** Whether polling is enabled (default: true) */
  enabled?: boolean;
  /** Whether WebSocket is connected (reduces polling frequency when true) */
  webSocketConnected?: boolean;
}

/** Polling interval when WebSocket is connected (30 seconds as backup) */
const WEBSOCKET_POLL_INTERVAL = 30000;
/** Polling interval when WebSocket is disconnected (5 seconds for real-time updates) */
const DEFAULT_POLL_INTERVAL = 5000;

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
export function usePoll({
  baseUrl = appBasename,
  pollInterval,
  enabled = true,
  webSocketConnected
}: UsePollOptions = {}) {
  const authFetch = useCsrfFetch();

  // Read WebSocket state internally so all callers automatically get the right interval.
  // The webSocketConnected prop is kept as an optional override for testing.
  const wsConnected = useWebSocketConnected();
  const isWsConnected = webSocketConnected ?? wsConnected;

  // Determine the effective poll interval based on WebSocket connection status
  // When WebSocket is connected, poll less frequently (30s) as a backup
  // When disconnected, poll frequently (5s) for real-time updates
  const effectiveInterval = pollInterval ?? (isWsConnected ? WEBSOCKET_POLL_INTERVAL : DEFAULT_POLL_INTERVAL);

  return useQuery({
    queryKey: POLL_QUERY_KEY,
    queryFn: async ({ signal }): Promise<PollData> => {
      // Pass the AbortSignal to allow TanStack Query to cancel in-flight requests
      const response = await authFetch(`${baseUrl}/api/poll`, undefined, signal);

      if (!response.ok) {
        throw new Error(`Poll request failed: ${response.status}`);
      }

      return response.json();
    },
    enabled,
    // Use function form to prevent overlapping requests on slow networks
    // Returns false (skip refetch) if a request is currently in progress
    refetchInterval: (query) => {
      if (query.state.fetchStatus === 'fetching') {
        return false; // Skip this interval, wait for current request to complete
      }
      return effectiveInterval;
    },
    staleTime: effectiveInterval - 1000, // Consider stale just before next poll
    gcTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
    // Only refetch on window focus when WebSocket is disconnected
    refetchOnWindowFocus: !isWsConnected,
  });
}
