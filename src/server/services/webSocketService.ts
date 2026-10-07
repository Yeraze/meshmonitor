/**
 * WebSocket Service
 *
 * Initializes Socket.io server for real-time mesh data updates.
 * Supports two authentication methods:
 * - Express session (web UI)
 * - Bearer token via handshake auth (API clients)
 * A connection with neither is refused, so a signed-out browser gets nothing
 * here and reads through the REST routes as the `anonymous` user.
 *
 * ## What a socket receives
 *
 * Every event forwarded from `dataEventEmitter` passes two tests, per socket:
 *
 * 1. **Subscription.** The socket asked for the event's source: it joined
 *    that source (`join-source`) or every source it may read
 *    (`join-all-sources`, the unified views). A socket that has asked for
 *    nothing gets no source event. Exception: an admin socket that has joined
 *    nothing still gets every source, as it always has.
 * 2. **Permission.** The socket's user holds, now, the grant the event's gate
 *    names on the event's own source (`socketEventGates.ts`). The payload is
 *    filtered or redacted for that user before it is sent; nothing is sent
 *    whole and left for the client to hide.
 *
 * Grants are held in memory per user and dropped the moment they change
 * (`socketAccess.ts`), so the permission test costs no query per event.
 */

import { Server as HttpServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import type { RequestHandler } from 'express';
import { dataEventEmitter, type DataEvent } from './dataEventEmitter.js';
import { logger } from '../../utils/logger.js';
import { getEnvironmentConfig } from '../config/environment.js';
import databaseService from '../../services/database.js';
import { ALL_SOURCES } from '../../db/repositories/index.js';
import { automationTraceBus, MAX_TRACE_MS } from './automation/automationTraceBus.js';
import { onAccessChange, type AccessChange } from '../../db/accessChanges.js';
import { gateFor, WITHHOLD, type SocketEventGate } from './socketEventGates.js';
import {
  SOCKET_ACCESS_TTL_MS,
  peekSocketViewer,
  loadSocketViewer,
  invalidateSocketAccess,
  forgetSocketViewer,
  type SocketViewer,
} from './socketAccess.js';

/** What the service keeps about one connected socket. */
interface SocketState {
  userId: number;
  /** The session the socket authenticated with, or null for an API token. */
  sessionId: string | null;
  /** The API token the socket authenticated with, or null for a session. */
  token: string | null;
  /** When the session or token was last confirmed still valid. */
  verifiedAt: number;
  /** Set when a token was revoked somewhere: re-validate this one before the next event. */
  tokenRecheck: boolean;
  /** Sources joined with `join-source`. */
  sources: Set<string>;
  /** Joined with `join-all-sources`: every source the user may read. */
  allSources: boolean;
  /**
   * The source joined last. Used to remap cross-source message channel slot
   * indexes so replies from other sources land in the correct channel bucket
   * on the client.
   */
  joinedSourceId: string | null;
  /** The re-check in flight, shared by every event that arrives meanwhile. */
  refreshing?: Promise<SocketViewer | null>;
}

// Store the Socket.io server instance for access from other modules
let io: SocketIOServer | null = null;
let stopAccessChanges: (() => void) | null = null;

const stateOf = (socket: Socket): SocketState | undefined => (socket.data as { access?: SocketState }).access;

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

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof (value as { then?: unknown } | null | undefined)?.then === 'function';

/** Run `compute` once; hand back its value directly once it is known. */
function once<T>(compute: () => T | Promise<T>): () => T | Promise<T> {
  let started = false;
  let value: T | Promise<T>;
  return () => {
    if (!started) {
      started = true;
      value = compute();
      if (isThenable(value)) {
        // Later callers get the value itself and need not await. A rejection
        // stays a rejected promise, so every caller sees it.
        void Promise.resolve(value).then(
          (resolved) => {
            value = resolved;
          },
          () => {},
        );
      }
    }
    return value;
  };
}

/** One event on its way to the sockets: the per-event work, done once. */
interface EventContext {
  event: DataEvent;
  gate: SocketEventGate;
  /** The payload as an admin gets it. */
  payload(): unknown | Promise<unknown>;
  /** The gate's `prepare` result. */
  prep(): unknown | Promise<unknown>;
  /** True once some viewer who is not an admin asked for `prep`. */
  prepStarted: boolean;
  /** Every channel row, for the cross-source slot remap. */
  channels(): Promise<Array<{ sourceId?: string | null; id: number; name?: string | null; psk?: string | null; role?: number | null }>>;
}

function contextFor(event: DataEvent, gate: SocketEventGate): EventContext {
  return {
    event,
    gate,
    payload: once(() => (gate.shape ? gate.shape(event) : event.data)),
    prep: once(() => (gate.prepare ? gate.prepare(event) : undefined)),
    prepStarted: false,
    // intentional cross-source: the map covers all sources to find equivalent slots on the joined source
    channels: once(() => databaseService.channels.getAllChannels(ALL_SOURCES)) as EventContext['channels'],
  };
}

/** Close a socket whose user, session or token is no longer good. */
function drop(socket: Socket, why: string): void {
  logger.debug(`[WebSocket] Disconnecting ${socket.id}: ${why}`);
  socket.emit('access-revoked', { reason: why });
  socket.disconnect(true);
}

/** True when the session or token the socket signed in with is still valid. */
async function credentialStillValid(socket: Socket, state: SocketState): Promise<boolean> {
  if (state.token !== null) {
    if (!state.tokenRecheck) return true;
    const user = await databaseService.validateApiTokenAsync(state.token);
    state.tokenRecheck = false;
    return !!user && user.id === state.userId;
  }
  const store = (socket.request as unknown as {
    sessionStore?: { get(id: string, done: (err: unknown, session?: { userId?: number } | null) => void): void };
  }).sessionStore;
  // No store to ask (a custom session middleware): nothing to re-check.
  if (!store || !state.sessionId) return true;
  const sessionId = state.sessionId;
  return new Promise<boolean>((resolve, reject) => {
    store.get(sessionId, (err, session) => {
      if (err) reject(err instanceof Error ? err : new Error(String(err)));
      // Gone (logout, expiry) or now another user's.
      else resolve(!!session && session.userId === state.userId);
    });
  });
}

/**
 * Confirm the socket's credential and (re)load its user's grants. Null when
 * the socket was disconnected (user gone or inactive, session ended, token
 * revoked) or the check failed; the caller then sends nothing.
 */
function refreshSocket(socket: Socket, state: SocketState): Promise<SocketViewer | null> {
  state.refreshing ??= (async () => {
    try {
      if (!(await credentialStillValid(socket, state))) {
        drop(socket, 'session ended');
        return null;
      }
      const held = peekSocketViewer(state.userId);
      const viewer = held !== undefined ? held : await loadSocketViewer(state.userId);
      if (!viewer) {
        drop(socket, 'account removed or deactivated');
        return null;
      }
      state.verifiedAt = Date.now();
      return viewer;
    } catch (err) {
      // Default-deny: an event is withheld when access cannot be established.
      logger.warn('[WebSocket] Access check failed; event withheld:', err);
      return null;
    } finally {
      state.refreshing = undefined;
    }
  })();
  return state.refreshing;
}

/** The socket's viewer when everything it rests on is fresh, with no I/O. */
function freshViewer(state: SocketState, now: number): SocketViewer | undefined {
  if (state.refreshing || now - state.verifiedAt >= SOCKET_ACCESS_TTL_MS) return undefined;
  return peekSocketViewer(state.userId, now) ?? undefined;
}

/** The socket's viewer, re-checked first when stale. Null: send nothing. */
function viewerFor(socket: Socket, state: SocketState): SocketViewer | Promise<SocketViewer | null> {
  return freshViewer(state, Date.now()) ?? refreshSocket(socket, state);
}

/** True when the socket asked for this event's source. */
function subscribed(state: SocketState, viewer: SocketViewer, event: DataEvent, gate: SocketEventGate): boolean {
  if (gate.scope === 'global' || !event.sourceId) return true;
  if (state.allSources || state.sources.has(event.sourceId)) return true;
  // An admin socket that joined nothing gets every source, as before.
  return viewer.isAdmin && state.sources.size === 0;
}

/** Emit one event's payload to one socket, remapping a cross-source channel slot first. */
function send(socket: Socket, state: SocketState, ctx: EventContext, outgoing: unknown): void {
  const { event } = ctx;
  if (event.type === 'message:new') {
    // Cross-source channel slot remap: if this message originated from a
    // different source than the one this socket joined, remap its channel
    // index to the equivalent slot (name+PSK match) on the joined source.
    const message = outgoing as { channel?: number };
    const msgSourceId = event.sourceId ?? (event.data as { sourceId?: string }).sourceId;
    const joined = state.joinedSourceId;
    if (joined && msgSourceId && msgSourceId !== joined && message.channel !== -1) {
      void ctx.channels().then((allChannels) => {
        const otherChannel = allChannels.find((c) => c.sourceId === msgSourceId && c.id === message.channel);
        const myEquivalent = otherChannel && otherChannel.name && otherChannel.role !== 0
          ? allChannels.find((c) => c.sourceId === joined && c.name === otherChannel.name && c.psk === otherChannel.psk)
          : undefined;
        socket.emit(event.type, myEquivalent ? { ...message, channel: myEquivalent.id } : message);
      }).catch((err) => {
        logger.warn('[WebSocket] Channel remap failed:', err);
        socket.emit(event.type, message);
      });
      return;
    }
  }
  socket.emit(event.type, outgoing);
}

/**
 * Deliver with no await when nothing needs one. Returns false when the
 * payload, the event facts or the viewer's own state must be awaited first.
 */
function deliverSync(socket: Socket, state: SocketState, viewer: SocketViewer, ctx: EventContext): boolean {
  const { event, gate } = ctx;
  if (!subscribed(state, viewer, event, gate)) return true;
  // The admin fast path: no gate, no event facts.
  if (!viewer.isAdmin) {
    if (gate.scope === 'source' && !event.sourceId) return true; // no source to check a grant on
    if (gate.ensure?.(viewer, event)) return false;
    if (gate.prepare) {
      ctx.prepStarted = true;
      if (isThenable(ctx.prep())) return false;
    }
  }
  const payload = ctx.payload();
  if (isThenable(payload)) return false;
  const outgoing = viewer.isAdmin ? payload : gate.filter(viewer, event.sourceId ?? '', payload, ctx.prep(), event);
  if (outgoing !== WITHHOLD) send(socket, state, ctx, outgoing);
  return true;
}

async function deliverAsync(socket: Socket, state: SocketState, ctx: EventContext): Promise<void> {
  const { event, gate } = ctx;
  try {
    const viewer = await viewerFor(socket, state);
    if (!viewer || !socket.connected) return;
    if (!subscribed(state, viewer, event, gate)) return;
    let outgoing: unknown;
    if (viewer.isAdmin) {
      outgoing = await ctx.payload();
    } else {
      if (gate.scope === 'source' && !event.sourceId) return;
      await gate.ensure?.(viewer, event);
      const prep = await ctx.prep();
      outgoing = gate.filter(viewer, event.sourceId ?? '', await ctx.payload(), prep, event);
    }
    if (outgoing !== WITHHOLD && socket.connected) send(socket, state, ctx, outgoing);
  } catch (err) {
    logger.warn(`[WebSocket] ${event.type} withheld from ${socket.id}: gate failed:`, err);
  }
}

const warnedUndeclared = new Set<string>();

/** Forward one data event to the sockets that asked for it and may have it. */
function dispatch(event: DataEvent): void {
  if (!io) return;
  const sockets = io.sockets.sockets;
  if (sockets.size === 0) return;
  const gate = gateFor(event.type);
  if (!gate) {
    // Default-deny: an event with no declared gate reaches no one.
    if (!warnedUndeclared.has(event.type)) {
      warnedUndeclared.add(event.type);
      logger.warn(`[WebSocket] Event "${event.type}" has no gate in SOCKET_EVENT_GATES; not forwarded`);
    }
    return;
  }
  const ctx = contextFor(event, gate);
  const now = Date.now();
  const sourceId = gate.scope === 'source' ? event.sourceId : undefined;
  let waiting: Array<[Socket, SocketState]> | undefined;
  for (const socket of sockets.values()) {
    const state = stateOf(socket);
    if (!state) continue;
    // Joined other sources only: decided without the viewer.
    if (sourceId && !state.allSources && state.sources.size > 0 && !state.sources.has(sourceId)) continue;
    const viewer = freshViewer(state, now);
    if (viewer && deliverSync(socket, state, viewer, ctx)) continue;
    (waiting ??= []).push([socket, state]);
  }
  if (waiting) void deliverWaiting(ctx, waiting);
}

/**
 * Finish an event for the sockets that could not be served at once. The work
 * the event itself needs (its payload, its facts) is awaited ONCE here; after
 * that most sockets are served with no await of their own. Only a socket whose
 * own access must be re-read takes the per-socket path.
 */
async function deliverWaiting(ctx: EventContext, waiting: Array<[Socket, SocketState]>): Promise<void> {
  try {
    await ctx.payload();
    if (ctx.prepStarted) await ctx.prep();
  } catch {
    // Left to deliverAsync below, which logs it per socket and withholds.
  }
  const now = Date.now();
  for (const [socket, state] of waiting) {
    if (!socket.connected) continue;
    const viewer = freshViewer(state, now);
    try {
      if (viewer && deliverSync(socket, state, viewer, ctx)) continue;
    } catch (err) {
      logger.warn(`[WebSocket] ${ctx.event.type} withheld from ${socket.id}: gate failed:`, err);
      continue;
    }
    void deliverAsync(socket, state, ctx);
  }
}

/** React to a change in what some user may see. */
function handleAccessChange(change: AccessChange): void {
  if (change.kind === 'all') {
    invalidateSocketAccess();
    return;
  }
  if (change.kind === 'user') invalidateSocketAccess(change.userId);
  if (!io) return;
  for (const socket of io.sockets.sockets.values()) {
    const state = stateOf(socket);
    if (!state) continue;
    if (change.kind === 'session') {
      if (state.sessionId === change.sessionId) drop(socket, 'signed out');
      continue;
    }
    if (change.kind === 'tokens') {
      if (state.token === null) continue;
      state.tokenRecheck = true;
      state.verifiedAt = 0;
    } else if (state.userId !== change.userId) {
      continue;
    }
    // Re-check now rather than on the next event, so a deleted or deactivated
    // user's socket closes at once. Chained after any re-check in flight,
    // which may have read the old state.
    void Promise.resolve(state.refreshing).then(() => {
      if (socket.connected) return refreshSocket(socket, state);
      return null;
    });
  }
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
    const refuse = () => next(new Error('Authentication required'));
    let userId: number | undefined;
    let sessionId: string | null = null;
    let token: string | null = null;

    // 1. Try session auth (web UI)
    const request = socket.request as unknown as { session?: { userId?: number }; sessionID?: string };
    if (request.session?.userId) {
      userId = request.session.userId;
      sessionId = request.sessionID ?? null;
    } else {
      // 2. Try Bearer token auth (API clients)
      const offered = socket.handshake.auth?.token as string | undefined;
      if (offered) {
        try {
          const user = await databaseService.validateApiTokenAsync(offered);
          if (user) {
            userId = user.id;
            token = offered;
          }
        } catch (err) {
          logger.warn(`[WebSocket] Token validation error:`, err);
        }
      }
    }

    if (userId === undefined) {
      logger.debug(`[WebSocket] Connection rejected: No valid session or token`);
      return refuse();
    }

    // The user's row decides who they are now: whether the account is still
    // active and whether it is an admin. The copy in the session can be stale.
    try {
      const held = peekSocketViewer(userId);
      const viewer = held !== undefined ? held : await loadSocketViewer(userId);
      if (!viewer) {
        logger.debug(`[WebSocket] Connection rejected: user ${userId} is gone or inactive`);
        return refuse();
      }
    } catch (err) {
      logger.warn('[WebSocket] Could not load access for a new connection:', err);
      return refuse();
    }

    const state: SocketState = {
      userId,
      sessionId,
      token,
      verifiedAt: Date.now(),
      tokenRecheck: false,
      sources: new Set(),
      allSources: false,
      joinedSourceId: null,
    };
    (socket.data as { access?: SocketState }).access = state;
    return next();
  });

  // Handle connections
  io.on('connection', (socket: Socket) => {
    const state = stateOf(socket)!;
    logger.debug(`[WebSocket] Client connected: ${socket.id} (user: ${state.userId})`);

    // Send initial connection acknowledgement with server info
    socket.emit('connected', {
      socketId: socket.id,
      timestamp: Date.now(),
    });

    // Handle client ping (for connection health monitoring)
    socket.on('ping', () => {
      socket.emit('pong', { timestamp: Date.now() });
    });

    // Subscription — a client joins a source to receive that source's events.
    // Joining is a filter on top of the per-event permission test, not a grant:
    // it succeeds for a user who may see anything of the source, and each
    // event is still checked against the grant its gate names.
    socket.on('join-source', async (sourceId: string, ack?: (result: { ok: boolean; error?: string }) => void) => {
      if (typeof sourceId !== 'string' || sourceId.length === 0) return;
      const reply = typeof ack === 'function' ? ack : undefined;
      const refuse = (error: string) => {
        socket.emit('join-source:error', { sourceId, error });
        reply?.({ ok: false, error });
      };
      try {
        const viewer = await viewerFor(socket, state);
        if (!viewer) return refuse('unauthorized');
        // Any grant on the source, not `messages:read` alone: a user with only
        // node or map grants must get node updates. A virtual-channel grant
        // counts on every source, as it does for GET /api/poll.
        if (!viewer.isAdmin && !viewer.holdsAnyGrantOn(sourceId) && !viewer.hasVirtualGrant) {
          logger.warn(`[WebSocket] Socket ${socket.id} denied join-source ${sourceId}`);
          return refuse('forbidden');
        }
        state.sources.add(sourceId);
        state.joinedSourceId = sourceId;
        logger.debug(`[WebSocket] Socket ${socket.id} joined source ${sourceId}`);
        reply?.({ ok: true });
      } catch (err) {
        logger.error('[WebSocket] join-source permission check failed:', err);
        refuse('internal');
      }
    });

    socket.on('leave-source', (sourceId: string) => {
      if (typeof sourceId === 'string' && sourceId.length > 0) {
        state.sources.delete(sourceId);
        if (state.joinedSourceId === sourceId) state.joinedSourceId = null;
        logger.debug(`[WebSocket] Socket ${socket.id} left source ${sourceId}`);
      }
    });

    // The unified views read every source the user may read. They used to
    // join nothing and rely on "no room = every source"; they now ask. Needs
    // no check of its own: each event is tested against the user's grants.
    socket.on('join-all-sources', (ack?: (result: { ok: boolean }) => void) => {
      state.allSources = true;
      if (typeof ack === 'function') ack({ ok: true });
    });

    socket.on('leave-all-sources', () => {
      state.allSources = false;
    });

    // ── Automation Engine live-trace ("view logs") ─────────────────────────
    // Opt-in, per-rule, time-bounded debug stream. Gated on automations:read.
    socket.on('automation-trace:start', async (raw: { automationId?: string; durationMs?: number }) => {
      const automationId = typeof raw?.automationId === 'string' ? raw.automationId : '';
      if (!automationId) {
        socket.emit('automation-trace:error', { error: 'bad-request' });
        return;
      }
      try {
        const viewer = await viewerFor(socket, state);
        if (!viewer) {
          socket.emit('automation-trace:error', { automationId, error: 'unauthorized' });
          return;
        }
        if (!viewer.can('automations', 'read', '')) {
          socket.emit('automation-trace:error', { automationId, error: 'forbidden' });
          return;
        }
        const dur = Math.min(Math.max(Number(raw?.durationMs) || MAX_TRACE_MS, 1000), MAX_TRACE_MS);
        const expiry = Date.now() + dur;
        // We don't verify the id exists in the DB: arming a non-existent/disabled
        // rule is harmless (it simply never emits) and self-expires, so a lookup
        // would add a query per arm for no safety benefit.
        void socket.join(`automation-trace:${automationId}`);
        automationTraceBus.arm(automationId, socket.id, expiry);
        socket.emit('automation-trace:started', { automationId, expiresAt: expiry });
        logger.debug(`[WebSocket] Socket ${socket.id} started trace for automation ${automationId}`);
      } catch (err) {
        logger.error('[WebSocket] automation-trace:start failed:', err);
        socket.emit('automation-trace:error', { automationId, error: 'internal' });
      }
    });

    socket.on('automation-trace:stop', (raw: { automationId?: string }) => {
      const automationId = typeof raw?.automationId === 'string' ? raw.automationId : '';
      if (!automationId) return;
      void socket.leave(`automation-trace:${automationId}`);
      automationTraceBus.disarm(automationId, socket.id);
      logger.debug(`[WebSocket] Socket ${socket.id} stopped trace for automation ${automationId}`);
    });

    // Handle disconnect
    socket.on('disconnect', (reason) => {
      automationTraceBus.disarmSocket(socket.id);
      // Keep the user's grants only while one of their sockets is connected.
      const stillConnected = io
        ? [...io.sockets.sockets.values()].some((other) => other !== socket && stateOf(other)?.userId === state.userId)
        : false;
      if (!stillConnected) forgetSocketViewer(state.userId);
      logger.debug(`[WebSocket] Client disconnected: ${socket.id} (reason: ${reason})`);
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

  // One listener for every socket: the per-event work is shared.
  dataEventEmitter.on('data', dispatch);
  stopAccessChanges = onAccessChange(handleAccessChange);

  // Deliver Automation Engine live-trace payloads to the sockets tracing the
  // rule. The engine calls automationTraceBus.emit(). `automations:read` is
  // re-checked for each socket, so a revoked user's trace stops.
  automationTraceBus.setSink((automationId, payload) => {
    const server = io;
    const room = server?.sockets.adapter.rooms.get(`automation-trace:${automationId}`);
    if (!server || !room) return;
    for (const socketId of room) {
      const socket = server.sockets.sockets.get(socketId);
      const state = socket ? stateOf(socket) : undefined;
      if (!socket || !state) continue;
      const deliver = (viewer: SocketViewer | null) => {
        if (!viewer) return;
        if (viewer.can('automations', 'read', '')) {
          socket.emit('automation:trace', payload);
        } else {
          void socket.leave(`automation-trace:${automationId}`);
          automationTraceBus.disarm(automationId, socket.id);
        }
      };
      const viewer = viewerFor(socket, state);
      if (isThenable(viewer)) void Promise.resolve(viewer).then(deliver);
      else deliver(viewer);
    }
  });

  return io;
}

/**
 * Shutdown the WebSocket server
 */
export async function shutdownWebSocket(): Promise<void> {
  if (io) {
    logger.info('[WebSocket] Shutting down WebSocket server...');

    // Flush any pending telemetry
    dataEventEmitter.flushPending();

    dataEventEmitter.off('data', dispatch);
    stopAccessChanges?.();
    stopAccessChanges = null;
    invalidateSocketAccess();

    // Close all connections
    await new Promise<void>((resolve) => {
      void io!.close(() => {
        logger.info('[WebSocket] WebSocket server closed');
        resolve();
      });
    });

    io = null;
  }
}
