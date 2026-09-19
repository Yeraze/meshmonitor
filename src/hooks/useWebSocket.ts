/**
 * WebSocket Hook
 *
 * Provides real-time mesh data updates via Socket.io.
 * Automatically updates TanStack Query cache when events are received.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { useQueryClient } from '@tanstack/react-query';
import { sourcePollQueryKey, type PollData, type RawMessage, type PollTraceroute } from './usePoll';
import { mergeNodeUpdate } from './mergeNodeUpdate';
import type { DeviceInfo, Channel } from '../types/device';
import { appBasename } from '../init';
import { useSource } from '../contexts/SourceContext';

/**
 * WebSocket connection state
 */
export interface WebSocketState {
  /** Whether the WebSocket is connected */
  connected: boolean;
  /** Socket ID when connected */
  socketId: string | null;
  /** Last error message if any */
  error: string | null;
  /**
   * The underlying Socket.io socket once a connection has been established.
   * Exposed so consumers (e.g. MeshCoreSourcePage) can attach event listeners
   * for events that update local component state rather than TanStack Query.
   */
  socket: Socket | null;
}

// --- MeshCore push-event payloads ---------------------------------------------
//
// Server-side these are emitted by `dataEventEmitter` and forwarded by
// `webSocketService` with per-source room scoping. See server/services for the
// authoritative shapes.

/**
 * MeshCore message arrived. Mirrors `MeshCoreMessage` from the server but
 * duplicated client-side to avoid importing server modules.
 */
export interface MeshCoreMessageEvent {
  id: string;
  fromPublicKey: string;
  toPublicKey?: string;
  text: string;
  timestamp: number;
  rssi?: number;
  snr?: number;
  sourceId?: string;
  expectedAckCrc?: number;
  estTimeout?: number;
}

/**
 * MeshCore OTA packet observed via the companion LogRxData push. Mirrors the
 * server's `DbMeshCorePacket`; powers the MeshCore Packet Monitor live feed.
 */
export interface MeshCoreOtaPacketEvent {
  id?: number;
  sourceId?: string;
  timestamp: number;
  payloadType: number;
  payloadTypeName?: string | null;
  routeType?: number | null;
  routeTypeName?: string | null;
  pathLenRaw?: number | null;
  hopCount?: number | null;
  pathHops?: string | null;
  snr?: number | null;
  rssi?: number | null;
  payloadSize?: number | null;
  rawHex?: string | null;
}

export interface MeshCoreContactPayload {
  publicKey: string;
  advName?: string;
  name?: string;
  advType?: number;
  lastSeen?: number;
  rssi?: number;
  snr?: number;
  latitude?: number;
  longitude?: number;
  lastAdvert?: number;
  pathLen?: number;
  /** Shape parity with the server's `MeshCoreContactResponse` (#4438). The
   *  server never actually sets this on a push event — it only exists on
   *  the synthetic local-node row, which is device-contact traffic only
   *  and is never itself re-emitted as a push. `useMeshCore` re-stamps
   *  `isLocal` client-side from `localNodeRef` so the flag survives a push
   *  merge regardless. */
  isLocal?: boolean;
}

export interface MeshCoreNodePayload {
  publicKey: string;
  name: string;
  advType: number;
  txPower?: number;
  radioFreq?: number;
  radioBw?: number;
  radioSf?: number;
  radioCr?: number;
  lastHeard?: number;
  rssi?: number;
  snr?: number;
  batteryMv?: number;
  uptimeSecs?: number;
  latitude?: number;
  longitude?: number;
}

export interface MeshCoreContactUpdateEvent {
  sourceId: string;
  contact: MeshCoreContactPayload;
}

export interface MeshCoreStatusUpdateEvent {
  sourceId: string;
  connected: boolean;
  node?: MeshCoreNodePayload | null;
}

export interface MeshCoreLocalNodeUpdateEvent {
  sourceId: string;
  node: MeshCoreNodePayload;
}

/**
 * Node update event data
 */
interface NodeUpdateEvent {
  nodeNum: number;
  node: Partial<DeviceInfo>;
}

/**
 * Connection status event data
 */
interface ConnectionStatusEvent {
  connected: boolean;
  nodeNum?: number;
  nodeId?: string;
  reason?: string;
}

/**
 * Traceroute complete event data. The server forwards its full DbTraceroute
 * row verbatim as this event's payload (webSocketService.ts does
 * `socket.emit(event.type, event.data)` with no trimming for any event type
 * other than `message:new`) — so besides the fields every traceroute always
 * has, it also carries the same optional fields `PollTraceroute` does
 * (id/routePositions/transportMechanism), just not `hopCount`, which the
 * server derives from `route` at poll-response time rather than storing.
 */
interface TracerouteCompleteEvent {
  id?: number;
  fromNodeNum: number;
  toNodeNum: number;
  fromNodeId: string;
  toNodeId: string;
  route: string;
  routeBack: string;
  snrTowards: string;
  snrBack: string;
  routePositions?: string;
  packetId?: number | null;
  transportMechanism?: number | null;
  timestamp: number;
  createdAt: number;
}

/**
 * Hook to manage WebSocket connection for real-time updates
 *
 * @param enabled - Whether the WebSocket connection should be active
 * @returns WebSocket connection state
 *
 * @example
 * ```tsx
 * const { connected, socketId } = useWebSocket(true);
 *
 * if (connected) {
 *   console.log('WebSocket connected:', socketId);
 * }
 * ```
 */
/**
 * Debounce window for the full-poll invalidation fallback used by
 * routing:update and telemetry:batch (see scheduleDebouncedPollInvalidate).
 */
const POLL_INVALIDATE_DEBOUNCE_MS = 2000;

export function useWebSocket(enabled: boolean = true): WebSocketState {
  const [state, setState] = useState<WebSocketState>({
    connected: false,
    socketId: null,
    error: null,
    socket: null,
  });

  const socketRef = useRef<Socket | null>(null);
  const queryClient = useQueryClient();
  const { sourceId } = useSource();

  // Helper to update a node in the cache
  const updateNodeInCache = useCallback((nodeNum: number, nodeUpdate: Partial<DeviceInfo>) => {
    const key = sourcePollQueryKey(sourceId);
    queryClient.setQueryData<PollData>(key, (old) => {
      if (!old?.nodes) return old;

      const updatedNodes = old.nodes.map((node) =>
        node.nodeNum === nodeNum ? mergeNodeUpdate(node, nodeUpdate) : node
      );

      return { ...old, nodes: updatedNodes };
    });
  }, [queryClient, sourceId]);

  // Helper to add a new message to the cache
  // Messages are ordered newest-first, so new messages go at the beginning
  const addMessageToCache = useCallback((message: RawMessage) => {
    // Skip traceroute messages — the /api/poll endpoint excludes them from
    // `messages` (they live in `pollData.traceroutes` instead, refreshed on
    // `traceroute:complete`). Inserting them here causes them to briefly
    // become messages[0]; the next poll then evicts them, which makes the
    // newest-message-id tracker in App.tsx think the previously-seen text
    // message at the new messages[0] is "new" and play the chime. (#2867)
    if (message.portnum === 70 /* TRACEROUTE_APP */) {
      return;
    }

    const key = sourcePollQueryKey(sourceId);
    queryClient.setQueryData<PollData>(key, (old) => {
      if (!old) {
        void queryClient.invalidateQueries({ queryKey: key });
        return old;
      }

      const existingMessages = old.messages || [];
      if (existingMessages.some(m => m.id === message.id)) {
        return old;
      }

      return {
        ...old,
        messages: [message, ...existingMessages],
      };
    });
  }, [queryClient, sourceId]);

  // Helper to update connection status in cache
  const updateConnectionInCache = useCallback((status: ConnectionStatusEvent) => {
    const key = sourcePollQueryKey(sourceId);
    queryClient.setQueryData<PollData>(key, (old) => {
      if (!old) return old;

      return {
        ...old,
        connection: {
          connected: status.connected,
          nodeResponsive: status.connected,
          configuring: old.connection?.configuring ?? false,
          userDisconnected: old.connection?.userDisconnected ?? false,
          nodeIp: old.connection?.nodeIp,
        },
      };
    });
  }, [queryClient, sourceId]);

  // Helper to update channels in cache
  const updateChannelInCache = useCallback((channel: Channel) => {
    const key = sourcePollQueryKey(sourceId);
    queryClient.setQueryData<PollData>(key, (old) => {
      if (!old?.channels) return old;

      const channelExists = old.channels.some(c => c.id === channel.id);

      let updatedChannels;
      if (channelExists) {
        updatedChannels = old.channels.map(c =>
          c.id === channel.id ? { ...c, ...channel } : c
        );
      } else {
        updatedChannels = [...old.channels, channel];
      }

      return { ...old, channels: updatedChannels };
    });
  }, [queryClient, sourceId]);

  // Helper to merge a completed traceroute into the cache. The event payload
  // is the server's full DbTraceroute row (see TracerouteCompleteEvent above)
  // — everything PollTraceroute needs except hopCount, which we derive the
  // same way pollRoutes.ts does: parse `route` as a JSON hop array and take
  // its length, falling back to 999 on anything unparseable.
  const addTracerouteToCache = useCallback((traceroute: TracerouteCompleteEvent) => {
    const key = sourcePollQueryKey(sourceId);
    queryClient.setQueryData<PollData>(key, (old) => {
      if (!old) {
        void queryClient.invalidateQueries({ queryKey: key });
        return old;
      }

      let hopCount = 999;
      try {
        if (traceroute.route) {
          const routeArray = JSON.parse(traceroute.route);
          if (Array.isArray(routeArray)) {
            hopCount = routeArray.length;
          }
        }
      } catch {
        hopCount = 999;
      }

      const merged: PollTraceroute = { ...traceroute, hopCount };
      const existing = old.traceroutes ?? [];
      // De-dup on redelivery (matched by id when present).
      const withoutDup = merged.id != null ? existing.filter(tr => tr.id !== merged.id) : existing;

      // Traceroutes are sorted timestamp DESC (see useTraceroutes.ts); this
      // is the newest, so it goes first.
      return { ...old, traceroutes: [merged, ...withoutDup] };
    });
  }, [queryClient, sourceId]);

  // routing:update and telemetry:batch (below) can't be merged into the
  // cache from their event payloads without risking wrong data — see the
  // handlers themselves for why — so they fall back to invalidating the
  // full poll query. Debounce that invalidation so a burst of either event
  // (the server itself batches telemetry every 1s, and a bulk send can
  // trigger many acks in quick succession) collapses into one ~3MB refetch
  // instead of one per event. usePoll's own 30s WebSocket-connected backup
  // poll already bounds worst-case staleness, so an unbounded trailing
  // debounce (no max-wait) is fine here.
  const invalidateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleDebouncedPollInvalidate = useCallback(() => {
    const key = sourcePollQueryKey(sourceId);
    if (invalidateTimeoutRef.current) {
      clearTimeout(invalidateTimeoutRef.current);
    }
    invalidateTimeoutRef.current = setTimeout(() => {
      invalidateTimeoutRef.current = null;
      void queryClient.invalidateQueries({ queryKey: key });
    }, POLL_INVALIDATE_DEBOUNCE_MS);
  }, [queryClient, sourceId]);

  useEffect(() => {
    if (!enabled) {
      // Disconnect if not enabled
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
        setState({ connected: false, socketId: null, error: null, socket: null });
      }
      return;
    }

    // Build the socket URL and path respecting BASE_URL
    // Explicit URL is required — Socket.io's auto-detection fails when a <base> tag is present
    const socketPath = `${appBasename}/socket.io`;
    const socketUrl = `${window.location.protocol}//${window.location.host}`;

    const socket = io(socketUrl, {
      path: socketPath,
      withCredentials: true,
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    socketRef.current = socket;
    // Expose the socket immediately so consumers can attach listeners before
    // the first `connect` fires.
    setState(prev => ({ ...prev, socket }));

    // Connection events
    socket.on('connect', () => {
      setState({
        connected: true,
        socketId: socket.id || null,
        error: null,
        socket,
      });
    });

    socket.on('disconnect', (reason) => {
      setState(prev => ({
        ...prev,
        connected: false,
        socketId: null,
        error: reason === 'io server disconnect' ? 'Server disconnected' : null,
      }));
    });

    socket.on('connect_error', (error) => {
      setState(prev => ({
        ...prev,
        connected: false,
        error: error.message,
      }));
    });

    // Server acknowledgement — join source room if we're in a source-specific view
    socket.on('connected', (data: { socketId: string; timestamp: number }) => {
      console.log('[WebSocket] Server acknowledged connection:', data.socketId);
      if (sourceId) {
        socket.emit('join-source', sourceId);
        console.log('[WebSocket] Joined source room:', sourceId);
      }
    });

    // Data events
    socket.on('node:updated', (data: NodeUpdateEvent) => {
      updateNodeInCache(data.nodeNum, data.node);
    });

    socket.on('message:new', (data: RawMessage) => {
      addMessageToCache(data);
      void queryClient.invalidateQueries({ queryKey: ['unreadCounts'] });
    });

    socket.on('channel:updated', (data: Channel) => {
      updateChannelInCache(data);
    });

    socket.on('connection:status', (data: ConnectionStatusEvent) => {
      updateConnectionInCache(data);
    });

    // The payload is the server's full DbTraceroute row, so this is a
    // targeted cache merge (see addTracerouteToCache) rather than a full
    // poll invalidation/refetch.
    socket.on('traceroute:complete', (data: TracerouteCompleteEvent) => {
      addTracerouteToCache(data);
    });

    // Can't merge: 'ack' alone doesn't say whether the DB moved the message
    // to 'delivered' (our own radio ack) or 'confirmed' (ack from the target
    // node, which also attaches rxSnr/rxRssi/relayNode for the Delivery
    // Details popup — see meshtasticManager.ts's two `updateMessageDeliveryState`
    // call sites) — the event payload has no field distinguishing the two, and
    // guessing would show wrong/incomplete delivery info. Debounced full-poll
    // invalidation instead.
    socket.on('routing:update', (_data: { requestId: number; status: string }) => {
      scheduleDebouncedPollInvalidate();
    });

    // Can't merge: payload is raw per-metric telemetry rows (DbTelemetry —
    // e.g. { telemetryType: 'batteryLevel', value: 85 }), not poll's
    // aggregated nodes[].deviceMetrics/environmentMetrics shape, and there's
    // no client-side telemetryType→field mapping to reconstruct it correctly.
    // (Node-level metrics themselves already stay live via node:updated,
    // which the ingest path emits separately — this event mainly exists to
    // refresh telemetryNodes membership for newly-telemetry-bearing nodes.)
    // Debounced full-poll invalidation instead.
    socket.on('telemetry:batch', (_data: { [nodeNum: number]: unknown[] }) => {
      scheduleDebouncedPollInvalidate();
    });

    socket.on('firmware:status', (data: unknown) => {
      // Store firmware update status for the FirmwareUpdateSection to consume
      queryClient.setQueryData(['firmware', 'liveStatus'], data);
    });

    // Waypoint events — invalidate any active waypoint queries for this source
    // so the WaypointsLayer / map re-fetch and reconcile.
    const invalidateWaypoints = () => {
      if (sourceId) {
        void queryClient.invalidateQueries({ queryKey: ['waypoints', sourceId] });
      } else {
        void queryClient.invalidateQueries({ queryKey: ['waypoints'] });
      }
    };
    socket.on('waypoint:upserted', invalidateWaypoints);
    socket.on('waypoint:deleted', invalidateWaypoints);
    socket.on('waypoint:expired', invalidateWaypoints);

    // Cleanup on unmount
    return () => {
      socket.disconnect();
      socketRef.current = null;
      if (invalidateTimeoutRef.current) {
        clearTimeout(invalidateTimeoutRef.current);
        invalidateTimeoutRef.current = null;
      }
    };
  // pollKey is derived from sourceId (primitive) — omit it here to avoid a new array
  // reference on every render triggering socket reconnects.
  }, [enabled, queryClient, sourceId, updateNodeInCache, addMessageToCache, updateConnectionInCache, updateChannelInCache, addTracerouteToCache, scheduleDebouncedPollInvalidate]);

  return state;
}

/**
 * Get whether WebSocket is supported in the current environment
 */
export function isWebSocketSupported(): boolean {
  return typeof WebSocket !== 'undefined';
}
