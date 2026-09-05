/**
 * mqtt.js client wrapper for connecting to an upstream MQTT broker.
 *
 * Used by MqttBridgeManager to bridge an upstream public broker to the
 * embedded local MqttBroker. Wraps mqtt.js with URL normalization,
 * reconnect-aware subscription tracking, and a small event surface.
 */

import { EventEmitter } from 'events';
import { connect, type IClientOptions, type IClientSubscribeOptions, type MqttClient } from 'mqtt';
import { logger } from '../../utils/logger.js';
import { createCachingLookup } from './cachingDnsLookup.js';

// One DNS cache shared across every upstream MQTT connection. The publisher
// pool opens one socket per gateway and reconnects re-resolve, so without this
// a busy bridge re-queries the broker hostname dozens of times per minute.
const sharedDnsLookup = createCachingLookup();

export interface MqttBrokerClientOptions {
  url: string;
  username?: string;
  password?: string;
  /**
   * Explicit MQTT Client ID. When set, used verbatim on CONNECT (no random
   * suffix). Takes precedence over `clientIdPrefix`. Use this when the
   * upstream broker filters CONNECT on Client ID — e.g. community brokers
   * that whitelist `!<8-hex>` patterns. See `MqttBridgePublisherPool` for
   * the per-gateway-identity use case.
   */
  clientId?: string;
  clientIdPrefix?: string;
  rejectUnauthorized?: boolean;
  /** MQTT Last Will and Testament. Forwarded verbatim to mqtt.js. */
  will?: IClientOptions['will'];
  /** Keepalive seconds. Defaults to 15 (Meshtastic-firmware parity). */
  keepalive?: number;
}

export interface MqttBrokerClientMessage {
  topic: string;
  payload: Buffer;
  retained: boolean;
}

/** Per-topic SUBACK outcome. `qos === 128` means broker denied the subscription. */
export interface MqttSubscriptionResult {
  topic: string;
  qos: 0 | 1 | 2 | 128;
}

/**
 * Snapshot of capability state inferred from the upstream broker's responses.
 * - canSubscribe: at least one subscribe attempt was granted (or no subs yet).
 * - canPublish: 'unknown' at QoS 0 — broker does not ACK denials, so we
 *   cannot directly observe publish-permission. Set to 'no' if the broker
 *   closed the connection mid-session after a publish (heuristic).
 * - authFailed: CONNACK returned BAD_USERNAME_OR_PASSWORD / NOT_AUTHORIZED.
 * - deniedSubscriptions: topic filters that were rejected with SUBACK 0x80.
 */
export interface MqttClientCapabilities {
  canSubscribe: boolean;
  canPublish: 'yes' | 'no' | 'unknown';
  authFailed: boolean;
  deniedSubscriptions: string[];
}

/**
 * Events emitted on the MqttBrokerClient EventEmitter:
 * - 'connect' / 'reconnect' / 'offline' / 'close'
 * - 'error' (error: Error)
 * - 'message' (msg: MqttBrokerClientMessage)
 * - 'subscription-result' (results: MqttSubscriptionResult[])
 *     fired after every subscribe SUBACK; includes both granted and denied entries.
 * - 'permission-denied' (reason: { kind: 'subscribe' | 'auth'; topics?: string[]; message: string })
 *     fired when the broker denied subscribe or rejected the CONNACK on auth grounds.
 */
/**
 * Coordinates reconnection across multiple MqttBrokerClient instances
 * targeting the same broker. Instead of N independent backoff timers
 * (which interleave to produce once-per-second aggregate retry storms),
 * a single shared timer fires and reconnects the clients that asked for it.
 *
 * ### Only pending clients reconnect (#5079)
 *
 * The original implementation reconnected **every** registered client on each
 * tick, healthy ones included. `mqtt.js`'s `_reconnect()` on an already-
 * connected client runs `end()` then `connect()` — a full teardown and a brand
 * new TCP socket. So in `per_gateway` mode, where the publisher pool registers
 * one client per gateway, a single flapping member tore down and rebuilt every
 * sibling socket on every tick. Worse, each forced teardown emitted `'close'`,
 * which called `requestReconnect()` again: the coordinator kept itself alive
 * forever after one initial drop. That is the connection storm in #5079 —
 * dozens of short-lived sockets with climbing source ports, one
 * "MQTT client connected" line each.
 *
 * The pending set fixes it: a tick reconnects only the clients that actually
 * dropped, and `MqttBrokerClient.doReconnect()` additionally no-ops while
 * connected, so a healthy socket is never churned.
 */
export class MqttReconnectCoordinator {
  private readonly clients = new Set<MqttBrokerClient>();
  /** Clients that reported a drop and are waiting for the next shared tick. */
  private readonly pending = new Set<MqttBrokerClient>();
  private backoffMs = 1000;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private static readonly BACKOFF_MIN_MS = 1000;
  private static readonly BACKOFF_MAX_MS = 60_000;

  register(client: MqttBrokerClient): void {
    this.clients.add(client);
  }

  unregister(client: MqttBrokerClient): void {
    this.clients.delete(client);
    this.pending.delete(client);
  }

  requestReconnect(client: MqttBrokerClient): void {
    if (!this.clients.has(client)) return;
    this.pending.add(client);
    if (this.timer) return;
    const jitter = this.backoffMs * 0.2 * (Math.random() - 0.5);
    const delay = Math.round(this.backoffMs + jitter);
    this.timer = setTimeout(() => {
      this.timer = null;
      const due = Array.from(this.pending);
      this.pending.clear();
      for (const c of due) {
        c.doReconnect();
      }
    }, delay);
    this.backoffMs = Math.min(this.backoffMs * 2, MqttReconnectCoordinator.BACKOFF_MAX_MS);
  }

  /**
   * A registered client held a connection past its stability window.
   *
   * The shared backoff resets only when *nobody* is still waiting to
   * reconnect. Previously any single client could reset it unconditionally,
   * so in a pool one healthy member kept pinning the throttle at 1s for a
   * flapping sibling — the storm never slowed down (#5079).
   */
  noteStableConnection(): void {
    if (this.pending.size > 0 || this.timer) return;
    this.backoffMs = MqttReconnectCoordinator.BACKOFF_MIN_MS;
  }

  /** Current shared retry delay in ms (diagnostics + tests). */
  getBackoffMs(): number {
    return this.backoffMs;
  }

  /** How many registered clients are waiting on the next shared tick. */
  getPendingCount(): number {
    return this.pending.size;
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending.clear();
    this.clients.clear();
  }
}

export class MqttBrokerClient extends EventEmitter {
  private readonly options: MqttBrokerClientOptions;
  private client: MqttClient | null = null;
  private readonly subscriptions = new Set<string>();
  private readonly deniedSubscriptions = new Set<string>();
  private connected = false;
  private lastError: string | null = null;
  private authFailed = false;
  private reconnectBackoffMs = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private coordinator: MqttReconnectCoordinator | null = null;
  private static readonly BACKOFF_MIN_MS = 1000;
  private static readonly BACKOFF_MAX_MS = 60_000;
  // A connection must stay up this long before its success counts as "stable"
  // and resets the reconnect backoff. Shorter than this and a flapping
  // connection would keep the backoff pinned at the minimum.
  //
  // MUST stay comfortably ABOVE BACKOFF_MAX_MS. It used to be 30s — half the
  // 60s cap — which turned the throttle into a sawtooth: the backoff climbed
  // to 32s, the next attempt then trivially survived the 30s window, reset to
  // 1s, and the burst repeated forever on a ~1 minute cycle. That is the
  // "backoff never grows" half of #5079.
  private static readonly STABLE_RESET_MS = 120_000;
  /** A session shorter than this counts as a flap, not a real connection. */
  private static readonly SHORT_SESSION_MS = 10_000;
  /** At most one flap-summary warning per this window. */
  private static readonly FLAP_SUMMARY_MS = 60_000;
  /** Consecutive short post-CONNACK sessions before we name the likely cause. */
  private static readonly DUPLICATE_ID_HINT_AFTER = 3;

  // --- Flap diagnostics (#5079) ---------------------------------------
  private resolvedUrl = '';
  private resolvedClientId = '';
  private connectedAt: number | null = null;
  /** Connects since the last connection that proved stable. 1 = healthy. */
  private connectsSinceStable = 0;
  /** Drops since the last connection that proved stable. 0 = healthy. */
  private dropsSinceStable = 0;
  private flapEpisodeStartedAt: number | null = null;
  private lastFlapSummaryAt = 0;
  private lastCloseReason: string | null = null;
  private lastErrorAt = 0;
  private shortSessionStreak = 0;
  private duplicateIdHintLogged = false;
  /** Set by disconnect() so a teardown-induced 'close' never re-arms a retry. */
  private stopping = false;

  constructor(options: MqttBrokerClientOptions) {
    super();
    this.options = options;
  }

  setCoordinator(coordinator: MqttReconnectCoordinator): void {
    this.coordinator = coordinator;
    coordinator.register(this);
  }

  connect(): Promise<void> {
    if (this.client) return Promise.resolve();

    const url = normalizeBrokerUrl(this.options.url);
    const clientId =
      this.options.clientId ??
      (this.options.clientIdPrefix ?? 'meshmonitor') +
        '-' +
        Math.random().toString(36).slice(2, 10);

    // Disable mqtt.js auto-reconnect — we manage reconnection ourselves
    // with exponential backoff (1s → 60s) to avoid hammering brokers that
    // reject auth or are temporarily down.
    // `lookup` is a valid net/tls socket option that mqtt.js forwards to the
    // underlying socket, but it isn't in mqtt.js's IClientOptions typings — so
    // declare it via an intersection rather than casting away the whole type.
    const connectOptions: IClientOptions & { lookup: typeof sharedDnsLookup } = {
      clientId,
      username: this.options.username,
      password: this.options.password,
      protocolVersion: 4, // MQTT 3.1.1
      clean: true,
      keepalive: this.options.keepalive ?? 15, // match Meshtastic firmware (PubSubClient default)
      reconnectPeriod: 0, // we handle reconnect ourselves
      connectTimeout: 30_000,
      rejectUnauthorized: this.options.rejectUnauthorized ?? true,
      // Cache DNS across connections/reconnects. The hostname stays on the
      // socket, so TLS SNI / cert validation is unaffected. See cachingDnsLookup.ts.
      lookup: sharedDnsLookup,
      // Omit the `will` key entirely when unset, so the connect-options object
      // stays byte-identical for every existing caller (D-5 / §3.4 of
      // MESHCORE_OBSERVER_PHASE2_SPEC.md).
      ...(this.options.will ? { will: this.options.will } : {}),
    };
    this.resolvedUrl = url;
    this.resolvedClientId = clientId;
    this.stopping = false;
    this.client = connect(url, connectOptions);

    this.client.on('connect', () => {
      const now = Date.now();
      this.connected = true;
      this.connectedAt = now;
      this.lastError = null;
      this.authFailed = false;
      // Only reset the reconnect backoff once the connection proves STABLE.
      // Resetting on every 'connect' let a flapping connection (e.g. a clientId
      // collision kicking it every second) keep the shared backoff pinned at
      // the 1s minimum, producing a relentless reconnect/DNS storm. A connect
      // that drops before the grace window now never resets backoff, so it
      // climbs 1s→…→60s and the storm throttles itself.
      this.armStableReset();
      this.connectsSinceStable += 1;
      if (this.connectsSinceStable === 1) {
        // State change into "connected" — the only line worth an info.
        this.flapEpisodeStartedAt = now;
        logger.info(`📡 MQTT client connected to ${url} (clientId=${clientId})`);
      } else {
        // Repeat connect inside a flap episode. One line per socket is what
        // buried the container logs in #5079, so these drop to debug and the
        // storm is surfaced by a rate-limited summary instead.
        logger.debug(
          `📡 MQTT reconnected to ${url} (clientId=${clientId}, attempt #${this.connectsSinceStable})`,
        );
        this.maybeLogFlapSummary(now);
      }
      // Re-subscribe on every connect (covers reconnects with clean=true).
      // Clear previously-tracked denials too — a fresh session may have
      // different ACLs (e.g. broker reconfigured).
      this.deniedSubscriptions.clear();
      if (this.subscriptions.size > 0) {
        const topics = Array.from(this.subscriptions);
        this.client!.subscribe(topics, { qos: 0 }, (err, granted, packet) => {
          this.handleSubscribeCallback(topics, err, granted, packet);
        });
      }
      this.emit('connect');
    });

    this.client.on('reconnect', () => this.emit('reconnect'));
    this.client.on('offline', () => {
      this.connected = false;
      this.connectedAt = null;
      this.clearStableReset();
      this.emit('offline');
    });
    this.client.on('close', () => {
      this.noteClose();
      this.connected = false;
      this.connectedAt = null;
      this.clearStableReset();
      this.scheduleReconnect();
      this.emit('close');
    });
    // MQTT 5 DISCONNECT packet. We hardcode protocolVersion 4 so this never
    // fires today, but if the client is ever bumped it carries the broker's
    // own reason code — by far the best drop diagnostic available.
    this.client.on('disconnect', (packet) => {
      const code = (packet as { reasonCode?: number } | undefined)?.reasonCode;
      this.lastCloseReason =
        code === undefined
          ? 'broker sent DISCONNECT'
          : `broker sent DISCONNECT (reasonCode=${code})`;
      this.lastErrorAt = Date.now();
    });
    this.client.on('error', (err) => {
      this.lastError = err.message;
      this.lastErrorAt = Date.now();
      logger.warn(`MQTT client error (${url}): ${err.message}`);
      // Classify CONNACK auth rejections. mqtt.js surfaces these as
      // ErrorWithReasonCode whose .code matches the MQTT 3.1.1 CONNACK
      // return code: 4 = BAD_USERNAME_OR_PASSWORD, 5 = NOT_AUTHORIZED.
      const code = (err as Error & { code?: number }).code;
      if (code === 4 || code === 5) {
        this.authFailed = true;
        const reason =
          code === 4
            ? 'Broker rejected username or password.'
            : 'Broker rejected authentication (not authorized).';
        this.emit('permission-denied', {
          kind: 'auth' as const,
          message: reason,
        });
      }
      this.emit('error', err);
    });
    this.client.on('message', (topic, payload, packet) => {
      this.emit('message', {
        topic,
        payload: Buffer.isBuffer(payload) ? payload : Buffer.from(payload),
        retained: !!packet.retain,
      });
    });

    return new Promise<void>((resolve) => {
      const done = () => {
        this.client!.off('connect', done);
        this.client!.off('error', done);
        resolve();
      };
      this.client!.on('connect', done);
      // Also resolve on the first error (e.g. CONNACK auth rejection) so
      // callers like MqttBridgeManager.start() are not blocked forever.
      // mqtt.js continues reconnecting in the background regardless.
      this.client!.on('error', done);
    });
  }

  subscribe(topics: string[]): Promise<void> {
    for (const t of topics) this.subscriptions.add(t);
    if (!this.client || !this.connected) return Promise.resolve();
    const opts: IClientSubscribeOptions = { qos: 0 };
    return new Promise<void>((resolve, reject) => {
      this.client!.subscribe(topics, opts, (err, granted, packet) => {
        const settled = this.handleSubscribeCallback(topics, err, granted, packet);
        // Reject only for true protocol/transport errors — a SUBACK that
        // denies some topics is captured in capabilities, not surfaced as
        // a thrown error, so the caller can keep running with reduced
        // functionality.
        if (settled.kind === 'error') reject(settled.error);
        else resolve();
      });
    });
  }

  publish(topic: string, payload: Buffer, retained = false): Promise<void> {
    if (!this.client) return Promise.reject(new Error('MqttBrokerClient not connected'));
    return new Promise<void>((resolve, reject) => {
      this.client!.publish(topic, payload, { qos: 0, retain: retained }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Reconnect this client, if it actually needs one.
   *
   * The `connected` guard is load-bearing (#5079): mqtt.js's `_reconnect()`
   * on a live client runs `end()` then `connect()`, i.e. it throws away a
   * perfectly good TCP socket and opens a fresh one. Reconnecting healthy
   * clients was the amplifier that turned one dropped pool member into
   * dozens of sockets per minute against the upstream broker.
   */
  doReconnect(): void {
    if (this.stopping || !this.client) return;
    if (this.connected) return;
    this.client.reconnect();
  }

  /**
   * Arm the stability timer: only after the connection has held for
   * STABLE_RESET_MS do we consider it stable and reset the reconnect backoff
   * (both this client's and the shared coordinator's). A flap that closes
   * before then leaves the backoff growing.
   */
  private armStableReset(): void {
    this.clearStableReset();
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null;
      this.reconnectBackoffMs = MqttBrokerClient.BACKOFF_MIN_MS;
      // The coordinator decides for itself — it will refuse while a sibling
      // is still waiting to reconnect.
      if (this.coordinator) this.coordinator.noteStableConnection();
      if (this.connectsSinceStable > 1) {
        const seconds = Math.round(MqttBrokerClient.STABLE_RESET_MS / 1000);
        logger.info(
          `📡 MQTT connection to ${this.resolvedUrl} (clientId=${this.resolvedClientId}) ` +
            `stable for ${seconds}s after ${this.connectsSinceStable} connect attempts — backoff reset`,
        );
      }
      this.connectsSinceStable = 1;
      this.dropsSinceStable = 0;
      this.flapEpisodeStartedAt = Date.now();
      this.shortSessionStreak = 0;
      this.duplicateIdHintLogged = false;
    }, MqttBrokerClient.STABLE_RESET_MS);
  }

  private clearStableReset(): void {
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
  }

  /**
   * Record *why* the connection dropped and log it proportionately.
   *
   * Before #5079 only the reconnect was visible, so a storm showed up as an
   * endless run of "connected" lines with no hint of what was knocking the
   * socket over. The first drop of an episode is a warning; the rest fold
   * into the rate-limited flap summary so the log stays readable.
   */
  private noteClose(): void {
    if (this.stopping) return;
    const now = Date.now();
    const uptimeMs = this.connectedAt === null ? null : now - this.connectedAt;
    const reason = this.describeCloseReason(now, uptimeMs);
    this.lastCloseReason = reason;

    if (uptimeMs !== null && uptimeMs < MqttBrokerClient.SHORT_SESSION_MS) {
      this.shortSessionStreak += 1;
    } else {
      this.shortSessionStreak = 0;
    }

    this.dropsSinceStable += 1;
    const where = `${this.resolvedUrl} (clientId=${this.resolvedClientId})`;
    if (this.dropsSinceStable === 1) {
      // First drop of an episode — loud, and it carries the reason.
      logger.warn(`📡 MQTT connection to ${where} dropped: ${reason}`);
    } else {
      // Repeats fold into the rate-limited summary. This covers the
      // never-reaches-CONNACK case (broker down) as well as a true flap:
      // there is no 'connect' event to count in that scenario, so keying
      // this off the connect counter would warn on every single retry.
      logger.debug(`📡 MQTT connection to ${where} dropped: ${reason}`);
      this.maybeLogFlapSummary(now);
    }

    // A run of sessions that die seconds after CONNACK, with no client-side
    // error, is the MQTT 3.1.1 §3.1.4 signature: another connection took the
    // Client ID and the broker evicted this one. Say so once — it is the
    // single most useful line an operator can get out of this failure.
    if (
      !this.duplicateIdHintLogged &&
      this.shortSessionStreak >= MqttBrokerClient.DUPLICATE_ID_HINT_AFTER &&
      !this.lastError
    ) {
      this.duplicateIdHintLogged = true;
      logger.warn(
        `📡 MQTT connection to ${where} has been evicted ${this.shortSessionStreak} times ` +
          `within seconds of connecting, with no client-side error. This is the classic ` +
          `duplicate Client ID signature (MQTT 3.1.1 §3.1.4): another client — a second ` +
          `MeshMonitor, or the gateway node itself — is connected to this broker using the ` +
          `same Client ID, and the broker kicks whichever session is older. Give this ` +
          `connection a unique Client ID, or stop the other publisher.`,
      );
    }
  }

  private describeCloseReason(now: number, uptimeMs: number | null): string {
    // An error within the last couple of seconds is almost certainly the cause.
    if (this.lastError && now - this.lastErrorAt <= 2000) {
      return `error: ${this.lastError}`;
    }
    if (uptimeMs === null) {
      return 'connection attempt failed before CONNACK (unreachable broker, refused socket, or TLS failure)';
    }
    if (uptimeMs < MqttBrokerClient.SHORT_SESSION_MS) {
      return (
        `broker closed the connection ${uptimeMs}ms after CONNACK with no client-side error ` +
        `— typically a duplicate Client ID (MQTT 3.1.1 §3.1.4), an ACL kick, or a keepalive timeout`
      );
    }
    return `connection closed after ${Math.round(uptimeMs / 1000)}s with no client-side error — broker-initiated or network drop`;
  }

  /**
   * Rate-limited storm summary. Replaces the per-reconnect info line, so the
   * flap stays visible (a silent storm is worse than a loud one) without one
   * log entry per socket.
   */
  private maybeLogFlapSummary(now: number): void {
    if (now - this.lastFlapSummaryAt < MqttBrokerClient.FLAP_SUMMARY_MS) return;
    this.lastFlapSummaryAt = now;
    const startedAt = this.flapEpisodeStartedAt ?? now;
    const windowSec = Math.max(1, Math.round((now - startedAt) / 1000));
    const nextDelay = this.coordinator
      ? this.coordinator.getBackoffMs()
      : this.reconnectBackoffMs;
    logger.warn(
      `📡 MQTT connection to ${this.resolvedUrl} (clientId=${this.resolvedClientId}) is flapping: ` +
        `${this.connectsSinceStable} connects / ${this.dropsSinceStable} drops in the last ${windowSec}s. ` +
        `Last drop: ${this.lastCloseReason ?? 'unknown'}. Next retry in ~${Math.round(nextDelay / 1000)}s.`,
    );
  }

  private scheduleReconnect(): void {
    if (this.stopping || !this.client) return;
    if (this.coordinator) {
      this.coordinator.requestReconnect(this);
      return;
    }
    if (this.reconnectTimer) return;
    const jitter = this.reconnectBackoffMs * 0.2 * (Math.random() - 0.5);
    const delay = Math.round(this.reconnectBackoffMs + jitter);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.client) {
        this.client.reconnect();
      }
    }, delay);
    this.reconnectBackoffMs = Math.min(
      this.reconnectBackoffMs * 2,
      MqttBrokerClient.BACKOFF_MAX_MS,
    );
  }

  /**
   * @param opts.flush When true, ends the underlying mqtt.js client
   *   non-forcefully first (`end(false)`) so any not-yet-flushed outgoing
   *   packet (e.g. a graceful-stop offline status publish) has a chance to
   *   actually hit the wire before the socket closes, per
   *   `MESHCORE_OBSERVER_PHASE2_SPEC.md` §2.4/E2E criterion 8 — `publish()`
   *   resolving only means mqtt.js accepted the packet, not that it was
   *   sent. Raced against a ~2s fallback that force-ends (`end(true)`) so
   *   a wedged/unreachable socket can never hang this promise forever.
   *   Default (omitted/false) is byte-identical to the original behavior:
   *   an immediate forced `end(true)`.
   */
  async disconnect(opts?: { flush?: boolean }): Promise<void> {
    // Set before end(): end() emits 'close', and without this the teardown
    // would arm a reconnect timer for a client we are throwing away.
    this.stopping = true;
    if (this.coordinator) {
      this.coordinator.unregister(this);
      this.coordinator = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearStableReset();
    if (!this.client) return;
    const client = this.client;

    if (opts?.flush) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(fallback);
          resolve();
        };
        const fallback = setTimeout(() => {
          client.end(true, {}, finish);
        }, 2000);
        client.end(false, {}, finish);
      });
    } else {
      await new Promise<void>((resolve) => {
        client.end(true, {}, () => resolve());
      });
    }

    this.client = null;
    this.connected = false;
    this.connectedAt = null;
    this.connectsSinceStable = 0;
    this.dropsSinceStable = 0;
    this.flapEpisodeStartedAt = null;
    this.shortSessionStreak = 0;
    this.duplicateIdHintLogged = false;
    this.subscriptions.clear();
    this.deniedSubscriptions.clear();
    this.authFailed = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  /** Why the connection last dropped, as reported in the logs. Null before any drop. */
  getLastCloseReason(): string | null {
    return this.lastCloseReason;
  }

  getCapabilities(): MqttClientCapabilities {
    const denied = Array.from(this.deniedSubscriptions).sort();
    const requested = this.subscriptions.size;
    // canSubscribe is true unless we asked for subs and every one was denied.
    const canSubscribe = requested === 0 ? true : denied.length < requested;
    return {
      canSubscribe,
      canPublish: 'unknown',
      authFailed: this.authFailed,
      deniedSubscriptions: denied,
    };
  }

  /**
   * Unify mqtt.js's two subscribe-callback shapes into a single decision:
   *
   * - On full success, mqtt.js v5 calls `cb(null, subs, packet)` where each
   *   `subs[i]` is `{topic, qos}` with the QoS the broker actually granted.
   * - On partial failure (any topic returned qos 0x80 in SUBACK), mqtt.js
   *   raises `cb(err, subs, packet)` where `err` is an `ErrorWithSubackPacket`
   *   with `err.packet.granted` holding the raw per-topic grant codes
   *   (numbers, including 128 for denials). The `subs[i].qos` array in this
   *   path is the *requested* qos, not the granted one — so we must read
   *   `err.packet.granted` to recover the denial bits.
   *
   * For a true protocol/transport error (no SUBACK arrived), `err.packet`
   * is absent and we propagate the failure to the caller.
   */
  private handleSubscribeCallback(
    requested: string[],
    err: Error | null | undefined,
    granted: Array<{ topic: string; qos: number }> | undefined,
    // mqtt.js's ISubackPacket['granted'] is `number[] | Object[]` because
    // MQTT 5 SUBACK uses reason-code objects while MQTT 3.1.1 uses plain
    // numbers. We hardcode protocolVersion: 4, so entries are numbers in
    // practice — but the type system can't narrow that, so accept the
    // broader shape and runtime-filter to numbers.
    packet: { granted?: ReadonlyArray<number | object> } | undefined,
  ): { kind: 'ok' } | { kind: 'error'; error: Error } {
    const subackPacket =
      packet ??
      (err as (Error & { packet?: { granted?: ReadonlyArray<number | object> } }) | null)?.packet;
    const rawGrants = subackPacket?.granted;

    if (rawGrants && Array.isArray(rawGrants) && rawGrants.length > 0) {
      const results: MqttSubscriptionResult[] = rawGrants.map((code, i) => ({
        topic: requested[i] ?? `?[${i}]`,
        qos: (typeof code === 'number'
          ? code
          : // MQTT 5 path (unused with protocolVersion:4 but kept defensive):
            // reason-code object may carry its own `reasonCode` field.
            (((code as { reasonCode?: number }).reasonCode ?? 0) as number)) as MqttSubscriptionResult['qos'],
      }));
      this.applySubackResults(results);
      return { kind: 'ok' };
    }

    if (granted && granted.length > 0) {
      const results: MqttSubscriptionResult[] = granted.map((g, i) => ({
        topic: typeof g.topic === 'string' ? g.topic : requested[i] ?? `?[${i}]`,
        qos: g.qos as MqttSubscriptionResult['qos'],
      }));
      this.applySubackResults(results);
      return { kind: 'ok' };
    }

    if (err) {
      logger.warn(`MQTT subscribe failed: ${err.message}`);
      return { kind: 'error', error: err };
    }
    // No err, no SUBACK packet, no granted — nothing to do.
    return { kind: 'ok' };
  }

  private applySubackResults(results: MqttSubscriptionResult[]): void {
    const newlyDenied: string[] = [];
    for (const r of results) {
      if (r.qos === 128) {
        if (!this.deniedSubscriptions.has(r.topic)) newlyDenied.push(r.topic);
        this.deniedSubscriptions.add(r.topic);
      } else {
        // Broker may grant a topic that was previously denied (ACL change).
        // Clear so capability state reflects the new reality.
        this.deniedSubscriptions.delete(r.topic);
      }
    }
    this.emit('subscription-result', results);
    if (newlyDenied.length > 0) {
      const list = newlyDenied.join(', ');
      logger.warn(
        `MQTT broker denied subscription to ${newlyDenied.length} topic(s): ${list}`,
      );
      this.emit('permission-denied', {
        kind: 'subscribe' as const,
        topics: newlyDenied,
        message: `Broker denied subscription to: ${list}`,
      });
    }
  }
}

// Bare host → mqtt://host; canonical TLS ports get mqtts://.
export function normalizeBrokerUrl(input: string): string {
  const trimmed = input.trim();
  if (/^(mqtt|mqtts|ws|wss|tcp|tls):\/\//i.test(trimmed)) {
    return trimmed;
  }
  const colonIdx = trimmed.lastIndexOf(':');
  if (colonIdx > 0) {
    const port = Number(trimmed.slice(colonIdx + 1));
    if (port === 8883 || port === 8884) return 'mqtts://' + trimmed;
  }
  return 'mqtt://' + trimmed;
}
