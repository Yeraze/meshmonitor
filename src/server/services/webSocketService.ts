/**
 * WebSocket Service
 *
 * Initializes Socket.io server for real-time mesh data updates.
 * Supports two authentication methods:
 * - Express session (web UI)
 * - Bearer token via handshake auth (API clients)
 */

import { Server as HttpServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import type { RequestHandler } from 'express';
import { dataEventEmitter, type DataEvent } from './dataEventEmitter.js';
import { logger } from '../../utils/logger.js';
import { getEnvironmentConfig } from '../config/environment.js';
import type { DbMessage } from '../../services/database.js';
import databaseService from '../../services/database.js';

/**
 * Transform a DbMessage to the format expected by the client (MeshMessage)
 * This mirrors the transformation in server.ts transformDbMessageToMeshMessage()
 */
function transformMessageForClient(msg: DbMessage): unknown {
  // Match the format from server.ts transformDbMessageToMeshMessage()
  // The timestamp needs to be a Date (serialized as ISO string) to match poll API format
  return {
    id: msg.id,
    from: msg.fromNodeId,
    to: msg.toNodeId,
    fromNodeId: msg.fromNodeId,
    toNodeId: msg.toNodeId,
    text: msg.text,
    channel: msg.channel,
    portnum: msg.portnum,
    timestamp: new Date(msg.rxTime ?? msg.timestamp),  // Convert to Date (serializes as ISO string)
    hopStart: msg.hopStart,
    hopLimit: msg.hopLimit,
    relayNode: msg.relayNode,
    replyId: msg.replyId,
    emoji: msg.emoji,
    rxSnr: msg.rxSnr,
    rxRssi: msg.rxRssi,
    requestId: (msg as any).requestId,
    wantAck: Boolean((msg as any).wantAck),
    ackFailed: Boolean((msg as any).ackFailed),
    routingErrorReceived: Boolean((msg as any).routingErrorReceived),
    deliveryState: (msg as any).deliveryState,
    acknowledged:
      msg.channel === -1
        ? (msg as any).deliveryState === 'confirmed'
          ? true
          : undefined
        : (msg as any).deliveryState === 'delivered' || (msg as any).deliveryState === 'confirmed'
        ? true
        : undefined,
    decryptedBy: msg.decryptedBy ?? (msg as any).decrypted_by ?? null,
  };
}

// Store the Socket.io server instance for access from other modules
let io: SocketIOServer | null = null;

/**
 * Get the Socket.io server instance
 */
export function getSocketIO(): SocketIOServer | null {
  return io;
}

/**
 * Get the count of connected WebSocket clients
 */
export function getConnectedClientCount(): number {
  if (!io) return 0;
  return io.engine.clientsCount;
}

/**
 * Initialize WebSocket server
 *
 * @param httpServer - The HTTP server to attach Socket.io to
 * @param sessionMiddleware - Express session middleware to share authentication
 * @returns The Socket.io server instance
 */
export function initializeWebSocket(
  httpServer: HttpServer,
  sessionMiddleware: RequestHandler
): SocketIOServer {
  const env = getEnvironmentConfig();

  // Determine the Socket.io path based on BASE_URL
  const basePath = env.baseUrl || '';
  const socketPath = `${basePath}/socket.io`;

  io = new SocketIOServer(httpServer, {
    path: socketPath,
    cors: {
      origin: true, // Allow any origin (session cookie validates authentication)
      credentials: true,
    },
    transports: ['websocket', 'polling'],
    // Connection options
    pingTimeout: 30000,
    pingInterval: 25000,
    // Upgrade timeout
    upgradeTimeout: 30000,
  });

  logger.info(`🔌 WebSocket server initialized on path: ${socketPath}`);

  // Wrap Express session middleware for Socket.io
  io.use((socket, next) => {
    // Create a fake response object for the session middleware
    const fakeRes = {
      end: () => {},
      setHeader: () => {},
      getHeader: () => undefined,
    };

    sessionMiddleware(
      socket.request as any,
      fakeRes as any,
      next as any
    );
  });

  // Authentication check - session first, then Bearer token fallback
  io.use(async (socket, next) => {
    // 1. Try session auth (web UI)
    const session = (socket.request as any).session;
    if (session?.userId) {
      (socket as any).userId = session.userId;
      (socket as any).username = session.username;
      (socket as any).isAdmin = session.isAdmin;
      logger.debug(`[WebSocket] Session auth: ${session.username}`);
      return next();
    }

    // 2. Try Bearer token auth (API clients)
    const token = socket.handshake.auth?.token as string | undefined;
    if (token) {
      try {
        const user = await databaseService.validateApiTokenAsync(token);
        if (user) {
          (socket as any).userId = user.id;
          (socket as any).username = user.username;
          (socket as any).isAdmin = user.isAdmin || false;
          logger.debug(`[WebSocket] Token auth: ${user.username}`);
          return next();
        }
      } catch (err) {
        logger.warn(`[WebSocket] Token validation error:`, err);
      }
    }

    logger.debug(`[WebSocket] Connection rejected: No valid session or token`);
    return next(new Error('Authentication required'));
  });

  // Handle connections
  io.on('connection', (socket: Socket) => {
    const username = (socket as any).username || 'unknown';
    logger.info(`[WebSocket] Client connected: ${socket.id} (user: ${username})`);

    // Per-socket joined sourceId (set on join-source). Used to remap cross-source
    // message channel slot indexes so replies from other sources land in the
    // correct channel bucket on the client.
    let joinedSourceId: string | null = null;

    // Subscribe to data events
    const handler = async (event: DataEvent) => {
      // Source-aware filtering: if the client has joined source rooms, only forward
      // events that match one of those rooms. Legacy clients (no rooms) get all events.
      // Exception: message:new events are globally visible across sources — broadcast to all.
      const sourceRooms = Array.from(socket.rooms).filter(r => r.startsWith('source:'));
      if (sourceRooms.length > 0 && event.sourceId && event.type !== 'message:new') {
        if (!sourceRooms.includes(`source:${event.sourceId}`)) {
          return; // Skip — event is from a source this client didn't join
        }
      }

      // Transform message data to client format before emitting
      if (event.type === 'message:new') {
        const dbMsg = event.data as DbMessage;
        let outgoing: any = transformMessageForClient(dbMsg);

        // Cross-source channel slot remap: if this message originated from a
        // different source than the one this socket joined, remap its channel
        // index to the equivalent slot (name+PSK match) on the joined source.
        try {
          const msgSourceId = event.sourceId ?? (dbMsg as any).sourceId;
          if (
            joinedSourceId &&
            msgSourceId &&
            msgSourceId !== joinedSourceId &&
            outgoing.channel !== -1
          ) {
            const allChannels = await databaseService.channels.getAllChannels();
            const myChannels = allChannels.filter(
              (c: any) => c.sourceId === joinedSourceId
            );
            const otherChannel = allChannels.find(
              (c: any) => c.sourceId === msgSourceId && c.id === outgoing.channel
            );
            if (otherChannel && otherChannel.name && otherChannel.role !== 0) {
              const myEquivalent = myChannels.find(
                (c: any) =>
                  c.name === otherChannel.name && c.psk === (otherChannel as any).psk
              );
              if (myEquivalent) {
                outgoing = { ...outgoing, channel: myEquivalent.id };
              }
            }
          }
        } catch (err) {
          logger.warn('[WebSocket] Channel remap failed:', err);
        }

        socket.emit(event.type, outgoing);
      } else {
        socket.emit(event.type, event.data);
      }
    };
    dataEventEmitter.on('data', handler);

    // Send initial connection acknowledgement with server info
    socket.emit('connected', {
      socketId: socket.id,
      timestamp: Date.now(),
    });

    // Handle client ping (for connection health monitoring)
    socket.on('ping', () => {
      socket.emit('pong', { timestamp: Date.now() });
    });

    // Room management — clients join a source room to receive only that source's events
    socket.on('join-source', async (sourceId: string) => {
      if (typeof sourceId !== 'string' || sourceId.length === 0) return;
      const sockUserId = (socket as any).userId as number | undefined;
      const sockIsAdmin = (socket as any).isAdmin as boolean | undefined;
      try {
        if (!sockIsAdmin) {
          if (sockUserId === undefined) {
            socket.emit('join-source:error', { sourceId, error: 'unauthorized' });
            return;
          }
          const allowed = await databaseService.checkPermissionAsync(
            sockUserId,
            'messages',
            'read',
            sourceId
          );
          if (!allowed) {
            logger.warn(`[WebSocket] Socket ${socket.id} denied join-source ${sourceId}`);
            socket.emit('join-source:error', { sourceId, error: 'forbidden' });
            return;
          }
        }
        socket.join(`source:${sourceId}`);
        joinedSourceId = sourceId;
        logger.debug(`[WebSocket] Socket ${socket.id} joined room source:${sourceId}`);
      } catch (err) {
        logger.error('[WebSocket] join-source permission check failed:', err);
        socket.emit('join-source:error', { sourceId, error: 'internal' });
      }
    });

    socket.on('leave-source', (sourceId: string) => {
      if (typeof sourceId === 'string' && sourceId.length > 0) {
        socket.leave(`source:${sourceId}`);
        if (joinedSourceId === sourceId) joinedSourceId = null;
        logger.debug(`[WebSocket] Socket ${socket.id} left room source:${sourceId}`);
      }
    });

    // Handle disconnect
    socket.on('disconnect', (reason) => {
      dataEventEmitter.off('data', handler);
      logger.info(`[WebSocket] Client disconnected: ${socket.id} (reason: ${reason})`);
    });

    // Handle errors
    socket.on('error', (error) => {
      logger.error(`[WebSocket] Socket error for ${socket.id}:`, error);
    });
  });

  // Handle server-level errors
  io.engine.on('connection_error', (err: any) => {
    logger.warn(`[WebSocket] Connection error: ${err.code} - ${err.message}`);
  });

  return io;
}

/**
 * Broadcast an event to all connected clients
 */
export function broadcast(event: string, data: unknown): void {
  if (io) {
    io.emit(event, data);
    logger.debug(`[WebSocket] Broadcast event: ${event}`);
  }
}

/**
 * Shutdown the WebSocket server
 */
export async function shutdownWebSocket(): Promise<void> {
  if (io) {
    logger.info('[WebSocket] Shutting down WebSocket server...');

    // Flush any pending telemetry
    dataEventEmitter.flushPending();

    // Close all connections
    await new Promise<void>((resolve) => {
      io!.close(() => {
        logger.info('[WebSocket] WebSocket server closed');
        resolve();
      });
    });

    io = null;
  }
}
