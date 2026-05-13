/**
 * WebSocket Hook
 *
 * Provides real-time mesh data updates via Socket.io.
 * Automatically updates TanStack Query cache when events are received.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { useQueryClient } from '@tanstack/react-query';
import { sourcePollQueryKey, type PollData, type RawMessage } from './usePoll';
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
 * Traceroute complete event data
 */
interface TracerouteCompleteEvent {
  fromNodeNum: number;
  toNodeNum: number;
  fromNodeId: string;
  toNodeId: string;
  route: string;
  routeBack: string;
  snrTowards: string;
  snrBack: string;
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
        queryClient.invalidateQueries({ queryKey: key });
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
      queryClient.invalidateQueries({ queryKey: ['unreadCounts'] });
    });

    socket.on('channel:updated', (data: Channel) => {
      updateChannelInCache(data);
    });

    socket.on('connection:status', (data: ConnectionStatusEvent) => {
      updateConnectionInCache(data);
    });

    socket.on('traceroute:complete', (_data: TracerouteCompleteEvent) => {
      queryClient.invalidateQueries({ queryKey: sourcePollQueryKey(sourceId) });
    });

    socket.on('routing:update', (_data: { requestId: number; status: string }) => {
      queryClient.invalidateQueries({ queryKey: sourcePollQueryKey(sourceId) });
    });

    socket.on('telemetry:batch', (_data: { [nodeNum: number]: unknown[] }) => {
      queryClient.invalidateQueries({ queryKey: sourcePollQueryKey(sourceId) });
    });

    socket.on('firmware:status', (data: unknown) => {
      // Store firmware update status for the FirmwareUpdateSection to consume
      queryClient.setQueryData(['firmware', 'liveStatus'], data);
    });

    // Waypoint events — invalidate any active waypoint queries for this source
    // so the WaypointsLayer / map re-fetch and reconcile.
    const invalidateWaypoints = () => {
      if (sourceId) {
        queryClient.invalidateQueries({ queryKey: ['waypoints', sourceId] });
      } else {
        queryClient.invalidateQueries({ queryKey: ['waypoints'] });
      }
    };
    socket.on('waypoint:upserted', invalidateWaypoints);
    socket.on('waypoint:deleted', invalidateWaypoints);
    socket.on('waypoint:expired', invalidateWaypoints);

    // Cleanup on unmount
    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  // pollKey is derived from sourceId (primitive) — omit it here to avoid a new array
  // reference on every render triggering socket reconnects.
  }, [enabled, queryClient, sourceId, updateNodeInCache, addMessageToCache, updateConnectionInCache, updateChannelInCache]);

  return state;
}

/**
 * Get whether WebSocket is supported in the current environment
 */
export function isWebSocketSupported(): boolean {
  return typeof WebSocket !== 'undefined';
}
