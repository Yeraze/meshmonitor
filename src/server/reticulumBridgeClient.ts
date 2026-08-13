/**
 * Typed WebSocket client for the meshmonitor-rns-bridge Python sidecar
 * (#3960 Phase 1a WP3, see docs/internal/dev-notes/RETICULUM_PHASE1A_BUILD_SPEC.md §3.5/§4.4).
 *
 * Pure transport: this module has zero RNS knowledge and does not touch the
 * database. It owns:
 *  - the `hello`/`welcome` handshake (token + protocol version)
 *  - the `configure`/`ready` handshake (attach vs tcp_peer mode)
 *  - request/response correlation by envelope `id` (used by `configure` and
 *    `get_status`)
 *  - typed event emission for bridge-pushed events (`announce`,
 *    `interface_stats`, `path_table`, `status`)
 *  - bounded exponential-backoff reconnect that re-runs both handshakes
 *
 * Reconnect rationale (build-spec wire-protocol fact #3): the bridge process
 * itself restarts (exit code 1) after 3 consecutive poller failures, and a
 * supervisor brings up a fresh process. There is no in-process recovery on
 * the bridge side — this client's reconnect/backoff loop is what
 * re-establishes the WS session (and re-sends `hello`/`configure`) against
 * that fresh process. Reconnect only engages after a connection has reached
 * `ready` at least once; a failure on the very first `connect()` call is
 * surfaced to the caller instead (mirrors `ensureReticulumManagerStarted`'s
 * create-or-reconnect recipe in reticulumConfig.ts, which owns first-attempt
 * retry policy).
 *
 * Uses the platform-global `WebSocket` (stable since Node 22, this repo's
 * floor runtime per CLAUDE.md) instead of the `ws` package, so the Node
 * image gains no extra runtime dependency for this client. Ping/pong
 * keepalive needs no application-level code: RFC 6455 requires an automatic
 * pong reply to a server-initiated ping at the protocol layer, and the
 * WHATWG WebSocket API deliberately does not expose control frames to
 * application code, so there is nothing for this client to drive.
 */

import { EventEmitter } from 'events';
import { logger } from '../utils/logger.js';
import {
  PROTOCOL_VERSION,
  MESSAGE_TYPE,
  FAILURE_CODE,
  decodeEnvelope,
  type Envelope,
  type FailureCode,
  type ReticulumMode,
  type TcpPeerConfig,
  type AnnounceMessage,
  type InterfaceStatsMessage,
  type PathTableMessage,
  type StatusMessage,
  type ErrorMessage,
  type WelcomeMessage,
  type ReadyMessage,
} from './reticulumProtocol.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_RECONNECT_INITIAL_DELAY_MS = 1_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 60_000;
/** 0 = unbounded, mirrors MeshCoreManager's reconnectMaxAttempts default. */
const DEFAULT_RECONNECT_MAX_ATTEMPTS = 0;

/** Env var for an operator-controlled allowlist of non-loopback bridge hosts (comma-separated hostnames/IPs). */
export const RETICULUM_BRIDGE_ALLOWED_HOSTS_ENV = 'RETICULUM_BRIDGE_ALLOWED_HOSTS';

/**
 * Loopback hostnames as `URL.hostname` renders them — note IPv6 `::1` comes
 * back bracketed (`[::1]`) from the WHATWG URL parser, unlike a bare IPv4
 * address or hostname.
 */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '[::1]', 'localhost']);

function parseAllowedHosts(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h.length > 0),
  );
}

/**
 * Validate a bridge WebSocket URL *before* it is ever handed to
 * `new WebSocket()`. `bridgeUrl` originates from admin-set source config, so
 * CodeQL's `js/request-forgery` (SSRF) query flags the config -> network-
 * request path even though the bridge is a loopback-only sidecar by design
 * (build spec: `bridgeUrl` defaults to `ws://127.0.0.1:<BRIDGE_PORT>`). This
 * guard is the barrier: it enforces
 *  - the string parses as a URL at all,
 *  - the scheme is exactly `ws:` or `wss:` (rejects `http:`, `file:`, etc.),
 *  - the hostname is loopback (127.0.0.1 / ::1 / localhost) OR present in the
 *    operator's `RETICULUM_BRIDGE_ALLOWED_HOSTS` allowlist (comma-separated
 *    hostnames/IPs — for a bridge deliberately run on a different host or
 *    container, e.g. its own pod in a Helm deployment).
 *
 * Callers MUST construct the `WebSocket` from the returned `URL` (e.g.
 * `.href`), not from the original raw string — CodeQL only recognizes this
 * as breaking the taint flow when the *validated* value reaches the sink.
 */
export function validateBridgeUrl(raw: string, env: NodeJS.ProcessEnv = process.env): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ReticulumBridgeError(undefined, `invalid bridge URL: ${raw}`);
  }

  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new ReticulumBridgeError(
      undefined,
      `bridge URL must use ws:// or wss://, got '${url.protocol}' (${raw})`,
    );
  }

  const hostname = url.hostname.toLowerCase();
  if (LOOPBACK_HOSTNAMES.has(hostname)) {
    return url;
  }

  const allowlist = parseAllowedHosts(env[RETICULUM_BRIDGE_ALLOWED_HOSTS_ENV]);
  if (allowlist.has(hostname)) {
    return url;
  }

  throw new ReticulumBridgeError(
    undefined,
    `bridge URL host '${hostname}' is not loopback and is not listed in ${RETICULUM_BRIDGE_ALLOWED_HOSTS_ENV} ` +
      `(add it to that comma-separated env var to allow a non-loopback bridge host)`,
  );
}

export interface ReticulumBridgeClientOptions {
  /** e.g. `ws://127.0.0.1:8765` */
  bridgeUrl: string;
  token: string;
  protocolVersion?: number;
  /** ms to wait for a handshake/request reply before failing it. Default 10000. */
  requestTimeoutMs?: number;
  /** ms before the first reconnect attempt after a post-ready drop. Default 1000. */
  reconnectInitialDelayMs?: number;
  /** ceiling for the doubling backoff delay. Default 60000. */
  reconnectMaxDelayMs?: number;
  /** 0 = retry forever (default); >0 stops scheduling after N attempts. */
  reconnectMaxAttempts?: number;
}

export interface ReticulumConnectParams {
  mode: ReticulumMode;
  /** attach mode */
  configDir?: string;
  /** tcp_peer mode */
  peers?: TcpPeerConfig[];
}

export type ReticulumBridgeClientState =
  | 'idle'
  | 'connecting'
  | 'handshaking'
  | 'configuring'
  | 'ready'
  | 'reconnecting'
  | 'closed';

/** Error raised for handshake/configure/request failures. `code` is set when the bridge sent a typed error frame. */
export class ReticulumBridgeError extends Error {
  readonly code?: FailureCode;

  constructor(code: FailureCode | undefined, message?: string) {
    super(message ?? code ?? 'Reticulum bridge error');
    this.name = 'ReticulumBridgeError';
    this.code = code;
  }
}

interface PendingRequest {
  resolve: (env: Envelope) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface HandshakeWaiter {
  resolve: (env: Envelope) => void;
  reject: (err: Error) => void;
}

let requestIdCounter = 0;
function nextRequestId(): string {
  requestIdCounter += 1;
  return `req-${Date.now()}-${requestIdCounter}`;
}

/**
 * Emits: 'welcome' (WelcomeMessage), 'ready' (ReadyMessage), 'announce'
 * (AnnounceMessage), 'interface_stats' (InterfaceStatsMessage), 'path_table'
 * (PathTableMessage), 'status' (StatusMessage), 'reconnecting'
 * ({attempt, delayMs}), 'close' (no payload), 'error' (Error — transport or
 * wire-level ErrorMessage failures; NOT emitted for a wire ErrorMessage that
 * is correlated to a pending request/handshake, which rejects that
 * request/handshake's promise instead).
 */
export class ReticulumBridgeClient extends EventEmitter {
  private readonly options: Required<
    Pick<ReticulumBridgeClientOptions, 'bridgeUrl' | 'token'>
  > &
    ReticulumBridgeClientOptions;

  private ws: WebSocket | null = null;
  private state: ReticulumBridgeClientState = 'idle';
  private everReady = false;
  private explicitDisconnect = false;
  private lastConnectParams: ReticulumConnectParams | null = null;

  private handshakeWaiter: HandshakeWaiter | null = null;
  private readonly pendingRequests = new Map<string, PendingRequest>();

  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ReticulumBridgeClientOptions) {
    super();
    this.options = options;
  }

  getState(): ReticulumBridgeClientState {
    return this.state;
  }

  isConnected(): boolean {
    return this.state === 'ready';
  }

  /**
   * Open the WebSocket, perform `hello`/`welcome`, then `configure`/`ready`.
   * Resolves once `ready` is received. Rejects with `ReticulumBridgeError`
   * (code set when the bridge sent a typed failure) on any handshake
   * failure — this first attempt is NOT auto-retried; only a drop *after*
   * reaching `ready` triggers this client's own reconnect loop.
   */
  async connect(params: ReticulumConnectParams): Promise<void> {
    this.explicitDisconnect = false;
    this.lastConnectParams = params;
    this.reconnectAttempts = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.connectOnce(params);
  }

  /** Explicit shutdown: cancels any pending reconnect and closes the socket. Does not reconnect. */
  disconnect(): void {
    this.explicitDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectAllPending(new ReticulumBridgeError(undefined, 'client disconnected'));
    this.state = 'closed';
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        // already closed/closing — nothing to do.
      }
    }
  }

  /** Request the bridge's current status via `get_status`/`status`. Only valid once `ready`. */
  async requestStatus(): Promise<StatusMessage> {
    if (!this.ws || this.state !== 'ready') {
      throw new ReticulumBridgeError(undefined, 'client is not connected');
    }
    const id = nextRequestId();
    return new Promise<StatusMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new ReticulumBridgeError(undefined, 'timed out waiting for status'));
      }, this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      this.pendingRequests.set(id, {
        resolve: (env) => resolve(env as StatusMessage),
        reject,
        timer,
      });
      this.send({ type: MESSAGE_TYPE.GET_STATUS, id });
    });
  }

  // --------------------------------------------------------------------
  // Connection lifecycle
  // --------------------------------------------------------------------

  private async connectOnce(params: ReticulumConnectParams): Promise<void> {
    this.state = 'connecting';
    // Validate once per connection attempt and build the socket from the
    // validated URL object (not the raw option string) — see
    // validateBridgeUrl()'s doc comment for why this matters to CodeQL.
    const validatedUrl = validateBridgeUrl(this.options.bridgeUrl);
    const ws = new WebSocket(validatedUrl.href);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        ws.removeEventListener('error', onOpenError);
        resolve();
      };
      const onOpenError = () => {
        ws.removeEventListener('open', onOpen);
        reject(new ReticulumBridgeError(FAILURE_CODE.BRIDGE_UNREACHABLE, 'failed to open WebSocket connection to bridge'));
      };
      ws.addEventListener('open', onOpen, { once: true });
      ws.addEventListener('error', onOpenError, { once: true });
    });

    ws.addEventListener('message', (ev: MessageEvent) => {
      const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
      this.handleRawMessage(raw);
    });
    ws.addEventListener('close', () => this.handleSocketClosed());
    ws.addEventListener('error', () => {
      // A post-open transport error is always followed by a 'close' event,
      // which drives reconnect scheduling — this handler only notifies
      // listeners that something went wrong.
      this.emit('error', new ReticulumBridgeError(undefined, 'WebSocket transport error'));
    });

    this.state = 'handshaking';
    const welcome = await this.performHello();
    this.emit('welcome', welcome);

    this.state = 'configuring';
    const ready = await this.performConfigure(params);
    this.emit('ready', ready);

    this.state = 'ready';
    this.everReady = true;
    this.reconnectAttempts = 0;
  }

  private performHello(): Promise<WelcomeMessage> {
    return new Promise<WelcomeMessage>((resolve, reject) => {
      const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.handshakeWaiter = null;
        reject(new ReticulumBridgeError(undefined, 'timed out waiting for welcome'));
      }, timeoutMs);
      this.handshakeWaiter = {
        resolve: (env) => {
          clearTimeout(timer);
          resolve(env as WelcomeMessage);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      this.send({
        type: MESSAGE_TYPE.HELLO,
        protocolVersion: this.options.protocolVersion ?? PROTOCOL_VERSION,
        token: this.options.token,
      });
    });
  }

  private performConfigure(params: ReticulumConnectParams): Promise<ReadyMessage> {
    const id = nextRequestId();
    return new Promise<ReadyMessage>((resolve, reject) => {
      const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new ReticulumBridgeError(undefined, 'timed out waiting for ready'));
      }, timeoutMs);
      this.pendingRequests.set(id, {
        resolve: (env) => resolve(env as ReadyMessage),
        reject,
        timer,
      });
      const fields: Record<string, unknown> & { type: string } = {
        type: MESSAGE_TYPE.CONFIGURE,
        id,
        mode: params.mode,
      };
      if (params.configDir !== undefined) fields.configDir = params.configDir;
      if (params.peers !== undefined) fields.peers = params.peers;
      this.send(fields);
    });
  }

  private handleSocketClosed(): void {
    if (this.ws === null && this.state === 'closed') {
      // disconnect() already tore this down synchronously.
      return;
    }
    this.ws = null;
    this.rejectAllPending(new ReticulumBridgeError(undefined, 'connection closed'));
    this.emit('close');

    if (this.explicitDisconnect) {
      this.state = 'closed';
      return;
    }
    if (this.everReady) {
      this.scheduleReconnect();
    } else {
      this.state = 'closed';
    }
  }

  private scheduleReconnect(): void {
    const maxAttempts = this.options.reconnectMaxAttempts ?? DEFAULT_RECONNECT_MAX_ATTEMPTS;
    if (maxAttempts > 0 && this.reconnectAttempts >= maxAttempts) {
      logger.warn(
        `[ReticulumBridgeClient] Reconnect attempts exhausted (${maxAttempts}); giving up on ${this.options.bridgeUrl}`,
      );
      this.state = 'closed';
      return;
    }

    const initial = this.options.reconnectInitialDelayMs ?? DEFAULT_RECONNECT_INITIAL_DELAY_MS;
    const max = this.options.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
    const delayMs = Math.min(max, initial * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.state = 'reconnecting';
    this.emit('reconnecting', { attempt: this.reconnectAttempts, delayMs });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.explicitDisconnect || !this.lastConnectParams) return;
      this.connectOnce(this.lastConnectParams).catch((err: unknown) => {
        logger.warn(
          `[ReticulumBridgeClient] Reconnect attempt ${this.reconnectAttempts} to ${this.options.bridgeUrl} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        this.scheduleReconnect();
      });
    }, delayMs);
  }

  // --------------------------------------------------------------------
  // Message decode/dispatch
  // --------------------------------------------------------------------

  private handleRawMessage(raw: string): void {
    let env: Envelope;
    try {
      env = decodeEnvelope(raw);
    } catch (e) {
      this.emit('error', e instanceof Error ? e : new Error(String(e)));
      return;
    }

    if (this.handshakeWaiter) {
      const waiter = this.handshakeWaiter;
      this.handshakeWaiter = null;
      if (env.type === MESSAGE_TYPE.WELCOME) {
        waiter.resolve(env);
      } else if (env.type === MESSAGE_TYPE.ERROR) {
        const errMsg = env as ErrorMessage;
        waiter.reject(new ReticulumBridgeError(errMsg.code, errMsg.message));
      } else {
        waiter.reject(new ReticulumBridgeError(undefined, `unexpected message type during handshake: ${env.type}`));
      }
      return;
    }

    if (env.id && this.pendingRequests.has(env.id)) {
      const pending = this.pendingRequests.get(env.id);
      if (!pending) return;
      this.pendingRequests.delete(env.id);
      clearTimeout(pending.timer);
      if (env.type === MESSAGE_TYPE.ERROR) {
        const errMsg = env as ErrorMessage;
        pending.reject(new ReticulumBridgeError(errMsg.code, errMsg.message));
      } else {
        pending.resolve(env);
      }
      return;
    }

    this.dispatchPushEvent(env);
  }

  private dispatchPushEvent(env: Envelope): void {
    switch (env.type) {
      case MESSAGE_TYPE.ANNOUNCE:
        this.emit('announce', env as AnnounceMessage);
        break;
      case MESSAGE_TYPE.INTERFACE_STATS:
        this.emit('interface_stats', env as InterfaceStatsMessage);
        break;
      case MESSAGE_TYPE.PATH_TABLE:
        this.emit('path_table', env as PathTableMessage);
        break;
      case MESSAGE_TYPE.STATUS:
        this.emit('status', env as StatusMessage);
        break;
      case MESSAGE_TYPE.ERROR: {
        const errMsg = env as ErrorMessage;
        this.emit('error', new ReticulumBridgeError(errMsg.code, errMsg.message));
        break;
      }
      default:
        logger.debug(`[ReticulumBridgeClient] Unhandled message type from bridge: ${env.type}`);
    }
  }

  private send(msg: Record<string, unknown> & { type: string }): void {
    if (!this.ws) {
      throw new ReticulumBridgeError(undefined, 'cannot send: not connected');
    }
    const envelope = { v: PROTOCOL_VERSION, ts: Date.now(), ...msg };
    this.ws.send(JSON.stringify(envelope));
  }

  private rejectAllPending(err: Error): void {
    if (this.handshakeWaiter) {
      const waiter = this.handshakeWaiter;
      this.handshakeWaiter = null;
      waiter.reject(err);
    }
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pendingRequests.clear();
  }
}
