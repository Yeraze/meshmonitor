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
  type LxmfMessageEvent,
  type DeliveryStateEvent,
  type LxmfMethod,
} from './reticulumProtocol.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_RECONNECT_INITIAL_DELAY_MS = 1_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 60_000;
/** 0 = unbounded, mirrors MeshCoreManager's reconnectMaxAttempts default. */
const DEFAULT_RECONNECT_MAX_ATTEMPTS = 0;

/** Env var for an operator-controlled allowlist of non-loopback bridge hosts (comma-separated hostnames/IPs). */
export const RETICULUM_BRIDGE_ALLOWED_HOSTS_ENV = 'RETICULUM_BRIDGE_ALLOWED_HOSTS';

/**
 * Loopback hosts as bare (unbracketed) literals — this module's own
 * constants, never derived from a parsed URL. This is the CONSTANT allowlist
 * both `validateBridgeUrl` (config-time fail-fast) and `connectOnce`'s sink
 * reconstruction (CodeQL barrier, see below) match against, so the two can
 * never disagree about which hosts are permitted.
 */
const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', '::1', 'localhost'];

/** Parses the operator's `RETICULUM_BRIDGE_ALLOWED_HOSTS` env var into bare host literals. */
function extraAllowedHostsFromEnv(env: NodeJS.ProcessEnv): string[] {
  const raw = env[RETICULUM_BRIDGE_ALLOWED_HOSTS_ENV];
  if (!raw) return [];
  return raw
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
}

/** The full set of host literals a bridge URL's hostname may match: loopback constants plus operator env extras. */
function allowedHostLiterals(env: NodeJS.ProcessEnv): string[] {
  return [...LOOPBACK_HOSTS, ...extraAllowedHostsFromEnv(env)];
}

/** `URL.hostname` brackets IPv6 (`[::1]`); strip that to compare against the bare literals in `allowedHostLiterals`. */
function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/**
 * Validate a bridge WebSocket URL for config-time fail-fast (called from
 * `reticulumConfigFromSource`, and again here at the top of `connectOnce`).
 * `bridgeUrl` originates from admin-set source config, so CodeQL's
 * `js/request-forgery` (SSRF) query flags the config -> network-request path
 * even though the bridge is a loopback-only sidecar by design (build spec:
 * `bridgeUrl` defaults to `ws://127.0.0.1:<BRIDGE_PORT>`). This function
 * enforces:
 *  - the string parses as a URL at all,
 *  - the scheme is exactly `ws:` or `wss:` (rejects `http:`, `file:`, etc.),
 *  - the hostname is loopback (127.0.0.1 / ::1 / localhost) OR present in the
 *    operator's `RETICULUM_BRIDGE_ALLOWED_HOSTS` allowlist.
 *
 * IMPORTANT: this function's return value (`URL`, and any string derived
 * from it such as `.href`/`.hostname`) must NOT be passed to
 * `new WebSocket()`. A same-value-different-function allowlist check is not
 * a sanitizer CodeQL's `js/request-forgery` query recognizes — the tainted
 * config string is still what reaches the sink. The actual connect target is
 * built separately in `connectOnce` from constant literals (see the comment
 * there) precisely so nothing tainted ever reaches `new WebSocket()`. This
 * function exists purely for the early, friendlier `reticulumConfigFromSource`
 * rejection — a config the sink guard would refuse anyway.
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

  const bareHostname = stripBrackets(url.hostname).toLowerCase();
  const allowed = allowedHostLiterals(env).some((h) => h.toLowerCase() === bareHostname);
  if (!allowed) {
    throw new ReticulumBridgeError(
      undefined,
      `bridge URL host '${url.hostname}' is not loopback and is not listed in ${RETICULUM_BRIDGE_ALLOWED_HOSTS_ENV} ` +
        `(add it to that comma-separated env var to allow a non-loopback bridge host)`,
    );
  }

  return url;
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

/**
 * Emits: 'welcome' (WelcomeMessage), 'ready' (ReadyMessage), 'announce'
 * (AnnounceMessage), 'interface_stats' (InterfaceStatsMessage), 'path_table'
 * (PathTableMessage), 'status' (StatusMessage), 'lxmf_message'
 * (LxmfMessageEvent — Phase 2), 'delivery_state' (DeliveryStateEvent —
 * Phase 2, unsolicited transitions AFTER the initial `send_lxmf` reply, which
 * is instead correlated by request id and resolves {@link sendLxmf}'s
 * promise), 'reconnecting' ({attempt, delayMs}), 'close' (no payload),
 * 'error' (Error — transport or wire-level ErrorMessage failures; NOT emitted
 * for a wire ErrorMessage that is correlated to a pending request/handshake,
 * which rejects that request/handshake's promise instead).
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

  /**
   * Per-instance request-id counter (moved off a module-level `let` —
   * PR review finding: a module-level counter lets parallel test workers /
   * multiple concurrently-running clients cross-correlate request ids,
   * which is both a test-isolation hazard and, in principle, a cross-client
   * id collision surface). Each client now mints its own monotonically
   * increasing sequence.
   */
  private requestIdCounter = 0;

  constructor(options: ReticulumBridgeClientOptions) {
    super();
    this.options = options;
  }

  /** Mint a request id scoped to this client instance (see `requestIdCounter`). */
  private nextRequestId(): string {
    this.requestIdCounter += 1;
    return `req-${Date.now()}-${this.requestIdCounter}`;
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
    const id = this.nextRequestId();
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
  // Phase 2 (LXMF messaging): id-correlated commands (build spec §5.4)
  // --------------------------------------------------------------------

  /**
   * Shared id-correlated request/response plumbing for the Phase 2 LXMF
   * commands below — same shape as {@link requestStatus}/{@link performConfigure},
   * generalized over the response envelope type since the five commands
   * reply with two different shapes (`send_lxmf` -> DeliveryStateEvent; the
   * other four -> ReadyMessage, per `ws_server.py`'s handlers).
   */
  private sendIdCorrelatedRequest<T extends Envelope>(
    fields: Record<string, unknown> & { type: string },
    timeoutLabel: string,
  ): Promise<T> {
    if (!this.ws || this.state !== 'ready') {
      throw new ReticulumBridgeError(undefined, 'client is not connected');
    }
    const id = this.nextRequestId();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new ReticulumBridgeError(undefined, `timed out waiting for ${timeoutLabel}`));
      }, this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      this.pendingRequests.set(id, {
        resolve: (env) => resolve(env as T),
        reject,
        timer,
      });
      this.send({ ...fields, id });
    });
  }

  /**
   * Send an LXMF message via the bridge's `send_lxmf` command. Resolves with
   * the initial `delivery_state` reply (`state: 'sending'`), which carries
   * the bridge-assigned, authoritative LXM `hash` — callers reconcile any
   * optimistically-persisted row id against that hash (see
   * `ReticulumManager.sendMessage`). Only valid once `ready`.
   */
  async sendLxmf(params: {
    to: string;
    title?: string;
    content?: string;
    fields?: Record<string, unknown>;
    method?: LxmfMethod;
    propagationNode?: string;
  }): Promise<DeliveryStateEvent> {
    const fields: Record<string, unknown> & { type: string } = { type: MESSAGE_TYPE.SEND_LXMF, to: params.to };
    if (params.title !== undefined) fields.title = params.title;
    if (params.content !== undefined) fields.content = params.content;
    if (params.fields !== undefined) fields.fields = params.fields;
    if (params.method !== undefined) fields.method = params.method;
    if (params.propagationNode !== undefined) fields.propagationNode = params.propagationNode;
    return this.sendIdCorrelatedRequest<DeliveryStateEvent>(fields, 'send_lxmf response');
  }

  /**
   * Announce our own LXMF identity to the network (`announce_self`). Needed
   * so a peer we message can validate our signature — LXMF requires the
   * receiver to already know the sender's identity (WP1 gotcha). Callers
   * should invoke this on every `ready` (initial connect AND reconnect), not
   * just once.
   */
  async announceSelf(): Promise<ReadyMessage> {
    return this.sendIdCorrelatedRequest<ReadyMessage>({ type: MESSAGE_TYPE.ANNOUNCE_SELF }, 'announce_self ack');
  }

  /** Set this identity's LXMF display name (`set_display_name`). */
  async setDisplayName(displayName: string): Promise<ReadyMessage> {
    return this.sendIdCorrelatedRequest<ReadyMessage>(
      { type: MESSAGE_TYPE.SET_DISPLAY_NAME, displayName },
      'set_display_name ack',
    );
  }

  /** Trigger a propagation-node sync (`sync_propagation`) — best-effort store-and-forward pickup. */
  async syncPropagation(): Promise<ReadyMessage> {
    return this.sendIdCorrelatedRequest<ReadyMessage>({ type: MESSAGE_TYPE.SYNC_PROPAGATION }, 'sync_propagation ack');
  }

  /** Configure the propagation node destination hash (`set_propagation_node`). */
  async setPropagationNode(destinationHash: string): Promise<ReadyMessage> {
    return this.sendIdCorrelatedRequest<ReadyMessage>(
      { type: MESSAGE_TYPE.SET_PROPAGATION_NODE, destinationHash },
      'set_propagation_node ack',
    );
  }

  // --------------------------------------------------------------------
  // Connection lifecycle
  // --------------------------------------------------------------------

  private async connectOnce(params: ReticulumConnectParams): Promise<void> {
    this.state = 'connecting';
    // CodeQL js/request-forgery barrier (alert #183): validateBridgeUrl()'s
    // allowlist check lives in a separate function, so CodeQL does not treat
    // it as a sanitizer — a value derived end-to-end from the tainted
    // `bridgeUrl` config string (even `.href` off the validated URL) is
    // still flagged as reaching `new WebSocket()`. The actual fix: never let
    // a tainted value reach the sink at all. `parsed` below is used only to
    // pick a matching entry out of `allowedHostLiterals()` — a CONSTANT
    // array of this module's own literals plus operator env config — via
    // `.find()`. The returned `safeHost` is an element of that array, not a
    // transform of `parsed.hostname`, so the host string that ultimately
    // reaches `new WebSocket()` is provably one of our own constants,
    // regardless of whether any analyzer credits the comparison itself as a
    // barrier. Same idea for `scheme` (a two-way constant ternary) and
    // `port` (only ever the digits already proven to be a validated numeric
    // string, never copied through unchecked).
    const parsed = validateBridgeUrl(this.options.bridgeUrl);
    const env = process.env;
    const bareHostname = stripBrackets(parsed.hostname).toLowerCase();
    const safeHost = allowedHostLiterals(env).find((h) => h.toLowerCase() === bareHostname);
    if (safeHost === undefined) {
      // Defense in depth only — validateBridgeUrl() above already enforced
      // this exact allowlist, so reaching here means the two checks somehow
      // disagreed. Refuse rather than ever construct a URL from the
      // unvalidated hostname.
      throw new ReticulumBridgeError(FAILURE_CODE.BRIDGE_UNREACHABLE, `bridge host not allowed: ${parsed.hostname}`);
    }
    const scheme = parsed.protocol === 'wss:' ? 'wss:' : 'ws:';
    const port = /^[0-9]{1,5}$/.test(parsed.port) ? `:${parsed.port}` : '';
    const hostForUrl = safeHost.includes(':') ? `[${safeHost}]` : safeHost;
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    const target = `${scheme}//${hostForUrl}${port}${path}`;

    const ws = new WebSocket(target);
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
    const id = this.nextRequestId();
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
      case MESSAGE_TYPE.LXMF_MESSAGE:
        this.emit('lxmf_message', env as LxmfMessageEvent);
        break;
      case MESSAGE_TYPE.DELIVERY_STATE:
        // Only UNSOLICITED transitions reach here — the initial 'sending'
        // reply to a send_lxmf command carries the request's `id` and is
        // instead resolved via the pendingRequests correlation path above
        // (see handleRawMessage), never dispatched as a push event.
        this.emit('delivery_state', env as DeliveryStateEvent);
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
