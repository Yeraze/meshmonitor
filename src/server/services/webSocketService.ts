/**
 * WebSocket Service
 *
 * Initializes Socket.io server for real-time mesh data updates.
 * Shares Express session authentication with WebSocket connections.
 */

import { Server as HttpServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import type { RequestHandler } from 'express';
import { dataEventEmitter, type DataEvent } from './dataEventEmitter.js';
import { logger } from '../../utils/logger.js';
import { getEnvironmentConfig } from '../config/environment.js';
import type { DbMessage } from '../../services/database.js';

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

  // Authentication check - require valid session
  io.use((socket, next) => {
    const session = (socket.request as any).session;

    if (!session || !session.userId) {
      logger.debug(`[WebSocket] Connection rejected: No valid session`);
      return next(new Error('Authentication required'));
    }

    // Attach user info to socket for later use
    (socket as any).userId = session.userId;
    (socket as any).username = session.username;
    (socket as any).isAdmin = session.isAdmin;

    logger.debug(`[WebSocket] Authenticated connection from user: ${session.username}`);
    next();
  });

  // Handle connections
  io.on('connection', (socket: Socket) => {
    const username = (socket as any).username || 'unknown';
    logger.info(`[WebSocket] Client connected: ${socket.id} (user: ${username})`);

    // Subscribe to data events
    const handler = (event: DataEvent) => {
      // Transform message data to client format before emitting
      if (event.type === 'message:new') {
        const transformedMessage = transformMessageForClient(event.data as DbMessage);
        socket.emit(event.type, transformedMessage);
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
