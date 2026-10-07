/**
 * WebSocket test harness: the route harness plus a real socket.io server.
 *
 * `createRouteTestApp()` seeds real users, sources and permission rows in the
 * singleton `:memory:` database. This adds an HTTP server on a free port with
 * `initializeWebSocket()` attached to the SAME express-session middleware, so
 * a socket signs in with a real session cookie (or a real API token) and the
 * gate in `webSocketService` runs against real permission rows. Nothing about
 * the permission check is mocked.
 *
 * ```ts
 * let harness: SocketTestHarness;
 * beforeEach(async () => { harness = await createSocketTestApp(); });
 * afterEach(() => harness.close());
 *
 * const client = await harness.connectAs(harness.limited, { join: harness.sourceA });
 * dataEventEmitter.emitNewMessage(message, harness.sourceA);
 * await client.settle();
 * expect(client.payloads('message:new')).toHaveLength(1);
 * ```
 */
import { createServer, type Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { createRouteTestApp, type RouteTestHarness, type SeededUser } from './routeTestApp.js';
import { initializeWebSocket, shutdownWebSocket } from '../services/webSocketService.js';
import { resetSocketAccess } from '../services/socketAccess.js';
import databaseService from '../../services/database.js';

export interface ReceivedEvent {
  type: string;
  data: unknown;
}

export interface SocketTestClient {
  socket: ClientSocket;
  /** Every event received, in order (the `connected` greeting excluded). */
  received: ReceivedEvent[];
  /** The payloads received for one event type. */
  payloads(type: string): unknown[];
  /** `join-source`, resolved with the server's answer. */
  join(sourceId: string): Promise<{ ok: boolean; error?: string }>;
  /** `join-all-sources`. */
  joinAll(): Promise<void>;
  /**
   * Wait until anything the server was going to send for events already
   * emitted has arrived: a pause long enough for every asynchronous gate to
   * finish, then a ping/pong round trip behind it on the same connection. A
   * delivery that should not have happened is in `received` by then.
   */
  settle(): Promise<void>;
  /** Resolves when the server closes the connection. */
  disconnected(timeoutMs?: number): Promise<string>;
  close(): void;
}

export interface ConnectOptions {
  /** Sign in with this API token instead of a session. */
  token?: string;
  /** Join one source, or every permitted source, before resolving. */
  join?: string | 'all';
}

export interface SocketTestHarness extends RouteTestHarness {
  port: number;
  /** Connect as `user` (a real session). `null` connects with no credential. */
  connectAs(user: SeededUser | null, options?: ConnectOptions): Promise<SocketTestClient>;
  /** One permission row holding exactly the given actions. */
  grantRow(
    userId: number,
    resource: string,
    actions: { read?: boolean; write?: boolean; viewOnMap?: boolean },
    sourceId?: string,
  ): Promise<void>;
  /** Every per-source grant on `sourceId`, plus the global read grants. */
  grantEverythingOn(userId: number, sourceId: string): Promise<void>;
  /** A session cookie for `user`, as `loginAs` would store. */
  sessionCookie(user: SeededUser): Promise<string>;
  close(): Promise<void>;
}

/** How long `settle()` waits for asynchronous gates before its round trip. */
const SETTLE_MS = 120;

const PER_SOURCE_RESOURCES = [
  'channel_0', 'channel_1', 'channel_2', 'channel_3', 'channel_4', 'channel_5', 'channel_6', 'channel_7',
  'messages', 'nodes', 'nodes_private', 'traceroute', 'packetmonitor', 'configuration', 'connection', 'waypoints',
];
const GLOBAL_RESOURCES = ['info', 'dashboard', 'sources', 'automations'];

export async function createSocketTestApp(): Promise<SocketTestHarness> {
  const route = await createRouteTestApp({ mount: () => {} });
  resetSocketAccess();

  const httpServer: HttpServer = createServer(route.app);
  initializeWebSocket(httpServer, route.sessionMiddleware);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const port = (httpServer.address() as AddressInfo).port;
  const clients: ClientSocket[] = [];

  const sessionCookie = async (user: SeededUser): Promise<string> => {
    const res = await fetch(`http://localhost:${port}/__test__/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: user.id }),
    });
    const cookie = res.headers.get('set-cookie');
    if (!cookie) throw new Error('socketTestApp: login set no session cookie');
    return cookie.split(';')[0];
  };

  const connectAs = async (user: SeededUser | null, options: ConnectOptions = {}): Promise<SocketTestClient> => {
    const cookie = user && !options.token ? await sessionCookie(user) : undefined;
    const socket = ioClient(`http://localhost:${port}`, {
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      ...(cookie ? { extraHeaders: { Cookie: cookie } } : {}),
      ...(options.token ? { auth: { token: options.token } } : {}),
    });
    clients.push(socket);
    const received: ReceivedEvent[] = [];
    socket.onAny((type: string, data: unknown) => {
      if (type !== 'connected' && type !== 'pong') received.push({ type, data });
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('connected', () => resolve());
      socket.once('connect_error', reject);
    });

    const client: SocketTestClient = {
      socket,
      received,
      payloads: (type) => received.filter((event) => event.type === type).map((event) => event.data),
      join: (sourceId) =>
        new Promise((resolve) => socket.emit('join-source', sourceId, (answer: { ok: boolean; error?: string }) => resolve(answer))),
      joinAll: () => new Promise<void>((resolve) => socket.emit('join-all-sources', () => resolve())),
      settle: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, SETTLE_MS));
        if (!socket.connected) return;
        await new Promise<void>((resolve) => {
          socket.once('pong', () => resolve());
          socket.emit('ping');
        });
      },
      disconnected: (timeoutMs = 2000) =>
        new Promise<string>((resolve, reject) => {
          if (!socket.connected) return resolve('already');
          const timer = setTimeout(() => reject(new Error('socket was not disconnected')), timeoutMs);
          socket.once('disconnect', (reason) => {
            clearTimeout(timer);
            resolve(reason);
          });
        }),
      close: () => socket.disconnect(),
    };
    if (options.join === 'all') await client.joinAll();
    else if (options.join) await client.join(options.join);
    return client;
  };

  const grantRow: SocketTestHarness['grantRow'] = async (userId, resource, actions, sourceId) => {
    await databaseService.auth.createPermission({
      userId,
      resource,
      canRead: actions.read === true,
      canWrite: actions.write === true,
      canViewOnMap: actions.viewOnMap === true,
      sourceId: sourceId ?? null,
      grantedAt: Date.now(),
      grantedBy: null,
    });
  };

  const grantEverythingOn = async (userId: number, sourceId: string): Promise<void> => {
    for (const resource of PER_SOURCE_RESOURCES) {
      await grantRow(userId, resource, { read: true, viewOnMap: true }, sourceId);
    }
    for (const resource of GLOBAL_RESOURCES) {
      await grantRow(userId, resource, { read: true });
    }
  };

  const close = async (): Promise<void> => {
    for (const socket of clients) socket.disconnect();
    await shutdownWebSocket();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    resetSocketAccess();
    await route.cleanup();
  };

  return { ...route, port, connectAs, grantRow, grantEverythingOn, sessionCookie, close };
}
