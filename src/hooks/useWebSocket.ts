/**
 * WebSocket Hook
 *
 * Provides real-time mesh data updates via Socket.io.
 * Automatically updates TanStack Query cache when events are received.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { useQueryClient } from '@tanstack/react-query';
import { POLL_QUERY_KEY, type PollData, type RawMessage } from './usePoll';
import type { DeviceInfo, Channel } from '../types/device';
import { appBasename } from '../init';

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
  });

  const socketRef = useRef<Socket | null>(null);
  const queryClient = useQueryClient();

  // Helper to update a node in the cache
  const updateNodeInCache = useCallback((nodeNum: number, nodeUpdate: Partial<DeviceInfo>) => {
    queryClient.setQueryData<PollData>(POLL_QUERY_KEY, (old) => {
      if (!old?.nodes) return old;

      const updatedNodes = old.nodes.map((node) => {
        if (node.nodeNum === nodeNum) {
          return { ...node, ...nodeUpdate };
        }
        return node;
      });

      return { ...old, nodes: updatedNodes };
    });
  }, [queryClient]);

  // Helper to add a new message to the cache
  const addMessageToCache = useCallback((message: RawMessage) => {
    queryClient.setQueryData<PollData>(POLL_QUERY_KEY, (old) => {
      if (!old) return old;

      // Check if message already exists
      const existingMessages = old.messages || [];
      const messageExists = existingMessages.some(m => m.id === message.id);

      if (messageExists) {
        return old;
      }

      return {
        ...old,
        messages: [...existingMessages, message],
      };
    });
  }, [queryClient]);

  // Helper to update connection status in cache
  const updateConnectionInCache = useCallback((status: ConnectionStatusEvent) => {
    queryClient.setQueryData<PollData>(POLL_QUERY_KEY, (old) => {
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
  }, [queryClient]);

  // Helper to update channels in cache
  const updateChannelInCache = useCallback((channel: Channel) => {
    queryClient.setQueryData<PollData>(POLL_QUERY_KEY, (old) => {
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
  }, [queryClient]);

  useEffect(() => {
    if (!enabled) {
      // Disconnect if not enabled
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
        setState({ connected: false, socketId: null, error: null });
      }
      return;
    }

    // Build the socket path respecting BASE_URL
    const socketPath = `${appBasename}/socket.io`;

    const socket = io({
      path: socketPath,
      withCredentials: true,
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    socketRef.current = socket;

    // Connection events
    socket.on('connect', () => {
      setState({
        connected: true,
        socketId: socket.id || null,
        error: null,
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

    // Server acknowledgement
    socket.on('connected', (data: { socketId: string; timestamp: number }) => {
      console.log('[WebSocket] Server acknowledged connection:', data.socketId);
    });

    // Data events
    socket.on('node:updated', (data: NodeUpdateEvent) => {
      updateNodeInCache(data.nodeNum, data.node);
    });

    socket.on('message:new', (_data: RawMessage) => {
      // Invalidate cache to trigger refetch - ensures full processPollData flow runs
      // including timestamp conversion, notification sounds, and unread counts
      queryClient.invalidateQueries({ queryKey: POLL_QUERY_KEY });
    });

    socket.on('channel:updated', (data: Channel) => {
      updateChannelInCache(data);
    });

    socket.on('connection:status', (data: ConnectionStatusEvent) => {
      updateConnectionInCache(data);
    });

    socket.on('traceroute:complete', (_data: TracerouteCompleteEvent) => {
      // For traceroutes, invalidate the cache to refetch latest data
      // This ensures the traceroute display updates properly
      queryClient.invalidateQueries({ queryKey: POLL_QUERY_KEY });
    });

    socket.on('routing:update', (_data: { requestId: number; status: string }) => {
      // For routing updates (ACK/NAK), we could update message delivery status
      // For now, invalidate to refetch
      queryClient.invalidateQueries({ queryKey: POLL_QUERY_KEY });
    });

    socket.on('telemetry:batch', (_data: { [nodeNum: number]: unknown[] }) => {
      // For batched telemetry, invalidate the telemetry-related queries
      // The poll will refetch with updated telemetry data
      queryClient.invalidateQueries({ queryKey: POLL_QUERY_KEY });
    });

    // Cleanup on unmount
    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [enabled, queryClient, updateNodeInCache, addMessageToCache, updateConnectionInCache, updateChannelInCache]);

  return state;
}

/**
 * Get whether WebSocket is supported in the current environment
 */
export function isWebSocketSupported(): boolean {
  return typeof WebSocket !== 'undefined';
}
