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
import { useSource } from '../contexts/SourceContext';
import { useOptionalConnectionStatus } from '../contexts/dataContextState';
import { POLL_QUERY_KEY, sourcePollQueryKey } from './pollQueryKey';
import { getPollBase, setPollBase, mergePollReply, PollDeltaMismatchError, type PollReply } from './pollDelta';

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
  meshtasticSourceType?: string | null;
  baseUrl?: string;
  deviceMetadata?: {
    firmwareVersion?: string;
    rebootCount?: number;
    hasWifi?: boolean;
    hasEthernet?: boolean;
    hasBluetooth?: boolean;
    // True when the node is reached via a serial/BLE-to-TCP bridge and cannot
    // be flashed over the air. Gates the OTA firmware update UI.
    isBridged?: boolean;
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
  /**
   * `MeshPacket.TransportMechanism` of the packet that carried this route
   * (#5097, migration 160). Null on pre-migration rows; readers resolve that to
   * `'rf'` via `utils/tracerouteTransport.ts`. Drives the Show RF / UDP / MQTT
   * filter on the Dashboard and Map Analysis route-segment layers.
   */
  transportMechanism?: number | null;
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
  /**
   * Server-side ingest time. JSON-serialized as an ISO string by `new Date(...)`
   * on the server (see transformDbMessageToMeshMessage). Optional only for
   * back-compat with older server builds; clients should fall back to
   * `timestamp` when missing.
   */
  receivedAt?: string | number;
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
  deviceNodeNums?: number[];
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

// Poll query keys live in ./pollQueryKey (no imports) and are re-exported here.
export { POLL_QUERY_KEY, sourcePollQueryKey };

/**
 * Fetch the /api/poll payload for a given source. This is usePoll()'s own
 * queryFn, extracted so callers that need poll data OUTSIDE the hook (e.g.
 * App.tsx's checkConnectionStatus, which needs to read `connection` before
 * usePoll's query is enabled) can go through
 * `queryClient.fetchQuery({ queryKey: sourcePollQueryKey(sourceId), queryFn: () => fetchPollData(...) })`
 * instead of issuing their own bare fetch. Routing through fetchQuery shares/
 * dedupes with any other observer already fetching (or holding fresh data
 * for) the same query key, and writes the result into the same cache entry
 * usePoll() reads — so it doesn't cause a second, cache-invisible request.
 */
export async function fetchPollData(
  authFetch: (url: string, options?: RequestInit, signal?: AbortSignal) => Promise<Response>,
  baseUrl: string,
  sourceId: string | null,
  signal?: AbortSignal
): Promise<PollData> {
  const url = sourceId
    ? `${baseUrl}/api/poll?sourceId=${encodeURIComponent(sourceId)}`
    : `${baseUrl}/api/poll`;

  // Incremental read: send the cursor of the last reply merged for this URL
  // and merge the delta onto that same reply (see ./pollDelta). An empty
  // cursor asks for the full reply and opts in to deltas after it.
  const read = async (useBase: boolean): Promise<PollData> => {
    const base = useBase ? getPollBase(url) : null;
    const cursor = base?.cursor ?? '';
    const response = await authFetch(
      `${url}${url.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}`,
      undefined,
      signal,
    );

    if (!response.ok) {
      throw new Error(`Poll request failed: ${response.status}`);
    }

    const reply = (await response.json()) as PollReply;
    const data = mergePollReply(base?.data ?? null, reply);
    setPollBase(url, reply.pollCursor, data);
    return data;
  };

  try {
    return await read(true);
  } catch (error) {
    // A delta that does not fit the held reply: drop it and read in full.
    if (!(error instanceof PollDeltaMismatchError)) throw error;
    setPollBase(url, undefined, {});
    return read(false);
  }
}

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

  // Read active source from context — scopes all poll queries to that source
  const { sourceId } = useSource();

  // Determine the effective poll interval based on WebSocket connection status
  // When WebSocket is connected, poll less frequently (30s) as a backup
  // When disconnected, poll frequently (5s) for real-time updates
  const effectiveInterval = pollInterval ?? (isWsConnected ? WEBSOCKET_POLL_INTERVAL : DEFAULT_POLL_INTERVAL);

  // Inside App, a source that is not connected is App's to watch: its
  // connection check reads the lightweight /api/connection and reads this
  // query once when the source comes back. Every always-enabled observer here
  // (useNodes, useChannels, ...) used to keep re-reading the full poll on its
  // own timer and on window focus as well, for data that does not change while
  // the source is down. They still read it once on mount. Outside a
  // DataProvider there is no such check, so polling is unchanged there.
  const appConnectionStatus = useOptionalConnectionStatus();
  const sourceLinkUp = appConnectionStatus === undefined || appConnectionStatus === 'connected';

  return useQuery({
    queryKey: sourceId ? ['poll', sourceId] : POLL_QUERY_KEY,
    // Pass the AbortSignal to allow TanStack Query to cancel in-flight requests
    queryFn: ({ signal }) => fetchPollData(authFetch, baseUrl, sourceId, signal),
    enabled,
    // Use function form to prevent overlapping requests on slow networks
    // Returns false (skip refetch) if a request is currently in progress
    refetchInterval: (query) => {
      if (!sourceLinkUp) return false;
      if (query.state.fetchStatus === 'fetching') {
        return false; // Skip this interval, wait for current request to complete
      }
      return effectiveInterval;
    },
    staleTime: effectiveInterval - 1000, // Consider stale just before next poll
    gcTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
    // Only refetch on window focus when WebSocket is disconnected
    refetchOnWindowFocus: !isWsConnected && sourceLinkUp,
  });
}
