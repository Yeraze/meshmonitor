/**
 * meshcoreObserverPublisher
 *
 * MeshCore Analyzer Observer publisher (#4457 Phase 2, WP4). One instance
 * per MeshCore Companion source: mints an auth token (Phase 1 WP3 seam),
 * opens one authenticated, publish-only MQTT socket to a
 * `michaelhart/meshcore-mqtt-broker`-compatible broker, relays every OTA
 * packet the radio hears (WP1's encoder), and publishes online/offline
 * status. **Never subscribes to anything** — that is this phase's headline
 * invariant (see `docs/internal/dev-notes/MESHCORE_OBSERVER_PHASE2_SPEC.md`
 * §2.2, §9 WP4, §10).
 *
 * Design notes (see the spec §3.2/§6 for the full derivation):
 * - Token minting happens at `start()` and again on a renewal timer — never
 *   per-packet. Minting is a WASM Ed25519 signature and is unaffordable at
 *   packet rate (Phase 1 §2.5).
 * - mqtt.js bakes `username`/`password` into the CONNECT packet, so renewal
 *   tears down the client and builds a fresh one with a fresh password and a
 *   fresh LWT (D-9) rather than trying to mutate an established connection.
 * - The renewal predicate deliberately widens the reference's threshold-only
 *   window by folding the check interval into it, closing a ~55-minute
 *   post-expiry hole the reference has. See `checkRenewal()` below and the
 *   spec §3.2 callout. Never hardcode the resulting 3900s constant — always
 *   derive it from `RENEWAL_CHECK_MS` / `RENEWAL_THRESHOLD_S`.
 * - Backpressure: `handleOtaPacket` gates on `client.isConnected()` itself
 *   and drops when the socket is down. mqtt.js queues QoS-0 publishes while
 *   offline by default, which would grow an unbounded in-memory queue on a
 *   busy mesh with a broker that's down — never let a publish reach a
 *   disconnected client.
 * - Auth-rejection cooldown: below `MAX_AUTH_FAILURES` we let the client's
 *   own backoff retry with the *same* token (a fresh token signed with the
 *   same key/audience would be rejected identically — re-minting per
 *   attempt is the hot-loop we must avoid). At `MAX_AUTH_FAILURES` we hard
 *   stop: clear the renewal timer and disconnect, and stay stopped until an
 *   operator-driven config change / reconnect.
 */
import { createRequire } from 'module';
import { MqttBrokerClient, type MqttBrokerClientOptions } from '../transports/mqttBrokerClient.js';
import { logger } from '../../utils/logger.js';
import type { OtaPacketEvent } from '../meshcoreVirtualNodeServer.js';
import type { MeshCoreConfig } from '../meshcoreManager.js';
import {
  buildObserverPacketPayload,
  buildObserverStatusPayload,
  observerTopics,
  type ObserverPacketIdentity,
  type ObserverStatsInput,
} from './meshcoreObserverPacket.js';
import {
  mintObserverTokenForSourceDetailed,
  type ObserverToken,
  type ObserverTokenResult,
} from './meshcoreObserverToken.js';

// createRequire interop for package.json, same pattern as newsService.ts.
const require = createRequire(import.meta.url);
const appVersion: string = require('../../../package.json').version;

/** Re-check the token's remaining life once an hour. */
export const RENEWAL_CHECK_MS = 3_600_000;
/**
 * Safety margin (seconds) folded on top of `RENEWAL_CHECK_MS` when deciding
 * whether to renew. See the module header / spec §3.2 for why the check
 * interval itself must be part of the window, not just this margin.
 */
export const RENEWAL_THRESHOLD_S = 300;
/** Consecutive CONNACK auth rejections before the publisher hard-stops. */
export const MAX_AUTH_FAILURES = 5;
/**
 * How often the retained `online` status is republished with fresh device
 * stats (#4556). Matches `meshcoretomqtt`'s 5-minute stats loop, so battery /
 * uptime / noise floor on the analyzer track the device instead of freezing
 * at their connect-time values. Each tick costs two local bridge commands
 * (`get_stats core` + `radio`) — no RF, so it is safe on a fixed interval.
 */
export const STATUS_REFRESH_MS = 300_000;

/** Strips anything shaped like a minted observer token (or a JWT-style secret) from a message. */
const TOKEN_SHAPE_PATTERN = /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[0-9A-Fa-f]{128}/g;

/** Never let a token/password-shaped substring escape into a user-visible `lastError`. */
function redactToken(message: string): string {
  return message.replace(TOKEN_SHAPE_PATTERN, '[REDACTED]');
}

const LAST_ERROR = {
  notConfigured: 'Analyzer Observer configuration is incomplete for this source.',
  noKey: 'No observer signing key stored for this source.',
  keyRotated:
    'Stored observer signing key cannot be decrypted (SESSION_SECRET changed). Re-import the key.',
  mintFailed: 'Failed to mint observer auth token.',
  authRejected: 'Broker rejected the observer auth token (check tokenAudience and the stored key).',
} as const;

export interface MeshCoreObserverStatus {
  /** `observer.enabled` AND all three config fields present. */
  configured: boolean;
  /** A signing key row exists AND is decryptable under the current SESSION_SECRET. */
  keyStored: boolean;
  connected: boolean;
  publishes: number;
  /** Packets dropped because the socket was down when they arrived. */
  dropped: number;
  lastPublishAt: number | null;
  lastError: string | null;
  /** Unix SECONDS (matches `ObserverToken.expiresAt`). */
  tokenExpiresAt: number | null;
}

export interface MeshCoreObserverPublisherOptions {
  sourceId: string;
  config: NonNullable<MeshCoreConfig['observer']>;
  /** Live device facts, read lazily at publish/status time — never cached at construction. */
  device: () => {
    origin: string;
    model?: string;
    firmwareVersion?: string;
    radio?: string;
  };
  /**
   * Live battery / uptime / noise-floor stats read off the attached companion
   * (#4556). Async because it costs a bridge round-trip, so it is only ever
   * called on the status path — never per-packet. Optional: a source that
   * can't supply stats simply publishes a status with no `stats` key.
   * Must resolve, not reject; a rejection is caught and treated as "no stats".
   */
  stats?: () => Promise<ObserverStatsInput | null>;
  /** Injection seam for tests. Defaults to `mintObserverTokenForSourceDetailed`. */
  mintToken?: (sourceId: string) => Promise<ObserverTokenResult>;
  /** Injection seam for tests. Defaults to `(opts) => new MqttBrokerClient(opts)`. */
  createClient?: (opts: MqttBrokerClientOptions) => MqttBrokerClient;
}

/** Minimal shape of the `permission-denied` event `MqttBrokerClient` emits. */
interface PermissionDeniedReason {
  kind: 'subscribe' | 'auth';
  topics?: string[];
  message: string;
}

export class MeshCoreObserverPublisher {
  private readonly options: MeshCoreObserverPublisherOptions;
  private readonly mintTokenFn: (sourceId: string) => Promise<ObserverTokenResult>;
  private readonly createClientFn: (opts: MqttBrokerClientOptions) => MqttBrokerClient;
  private readonly configured: boolean;

  private client: MqttBrokerClient | null = null;
  private topics: { region: string; packets: string; status: string } | null = null;
  private tokenPublicKey: string | null = null;

  private keyStored = false;
  private publishes = 0;
  private dropped = 0;
  private lastPublishAt: number | null = null;
  private lastError: string | null = null;
  private tokenExpiresAt: number | null = null;

  private running = false;
  private authFailures = 0;
  private authStopping = false;
  private renewing = false;
  private renewalTimer: ReturnType<typeof setInterval> | null = null;
  private statusRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshingStatus = false;

  constructor(options: MeshCoreObserverPublisherOptions) {
    this.options = options;
    this.mintTokenFn = options.mintToken ?? mintObserverTokenForSourceDetailed;
    this.createClientFn = options.createClient ?? ((opts) => new MqttBrokerClient(opts));
    this.configured = !!(
      options.config.enabled &&
      options.config.brokerUrl &&
      options.config.iataCode &&
      options.config.tokenAudience
    );
  }

  /**
   * Mint → connect → publish online status. Resolves even on failure — the
   * failure reason lands in `getStatus().lastError`, never a thrown error.
   */
  async start(): Promise<void> {
    // Reset the auth-failure state so a fresh start (e.g. a new instance
    // reused in tests, or any future restart path) is never poisoned by a
    // prior hard-stop — the guard is a concurrency latch, not a permanent
    // fuse (review #4468 obs. 4).
    this.authStopping = false;
    this.authFailures = 0;
    const result = await this.mintTokenFn(this.options.sourceId);
    if (result.kind !== 'ok') {
      this.keyStored = false;
      this.lastError = this.mintFailureMessage(result);
      return;
    }

    await this.connectWithToken(result.token);
    this.armRenewalTimer();
    this.armStatusRefreshTimer();
    this.running = true;
  }

  /** Publish an explicit offline status, then disconnect. Idempotent. */
  async stop(): Promise<void> {
    this.clearRenewalTimer();
    this.clearStatusRefreshTimer();
    const client = this.client;
    if (!client) {
      this.running = false;
      return;
    }

    this.client = null;
    this.running = false;

    const identity = this.getIdentity();
    if (identity && this.topics) {
      try {
        const offline = buildObserverStatusPayload('offline', identity);
        await client.publish(this.topics.status, Buffer.from(JSON.stringify(offline)), true);
      } catch {
        // Best-effort — a broker that's already unreachable shouldn't block shutdown.
      }
    }

    try {
      // flush:true — the offline publish above only resolves once mqtt.js
      // has accepted the packet, not once it's actually on the wire. A
      // plain forced end() (the default used elsewhere in this class, e.g.
      // renewal/hard-stop) can close the socket before that QoS-0 packet is
      // flushed, silently dropping the graceful-stop offline status (spec
      // §2.4 / E2E criterion 8).
      await client.disconnect({ flush: true });
    } catch {
      // Best-effort.
    }
  }

  /**
   * Sync, never throws. Call from the manager's `ota_packet` listener. No
   * token minting on this path — see the module header.
   */
  handleOtaPacket(event: OtaPacketEvent): void {
    const client = this.client;
    if (!client || !client.isConnected() || !this.topics || !this.tokenPublicKey) {
      this.dropped++;
      return;
    }

    const identity: ObserverPacketIdentity = {
      origin: this.options.device().origin,
      originId: this.tokenPublicKey,
    };
    const payload = buildObserverPacketPayload(event, identity);
    if (!payload) return; // blank/missing raw_hex — mirrors VN handleOtaPacket.

    void client
      .publish(this.topics.packets, Buffer.from(JSON.stringify(payload)), false)
      .then(() => {
        this.publishes++;
        this.lastPublishAt = Date.now();
      })
      .catch((err: unknown) => {
        this.lastError = redactToken(err instanceof Error ? err.message : String(err));
      });
  }

  getStatus(): MeshCoreObserverStatus {
    return {
      configured: this.configured,
      keyStored: this.keyStored,
      connected: this.client?.isConnected() ?? false,
      publishes: this.publishes,
      dropped: this.dropped,
      lastPublishAt: this.lastPublishAt,
      lastError: this.lastError,
      tokenExpiresAt: this.tokenExpiresAt,
    };
  }

  isRunning(): boolean {
    return this.running;
  }

  // ── internals ──────────────────────────────────────────────────────────

  private getIdentity(): ObserverPacketIdentity | null {
    if (!this.tokenPublicKey) return null;
    return { origin: this.options.device().origin, originId: this.tokenPublicKey };
  }

  private mintFailureMessage(result: Exclude<ObserverTokenResult, { kind: 'ok' }>): string {
    switch (result.kind) {
      case 'not_configured':
        return LAST_ERROR.notConfigured;
      case 'no_key':
        return LAST_ERROR.noKey;
      case 'key_rotated':
        return LAST_ERROR.keyRotated;
      case 'mint_failed':
        // The library error text can be verbose; log it at debug only and
        // never let it surface as `lastError` (Phase 1 §5.5 logging discipline).
        logger.debug(`[MeshCoreObserver:${this.options.sourceId}] mint failed: ${result.message}`);
        return LAST_ERROR.mintFailed;
    }
  }

  private buildClientOptions(
    token: ObserverToken,
    topics: { status: string },
  ): MqttBrokerClientOptions {
    const identity: ObserverPacketIdentity = {
      origin: this.options.device().origin,
      originId: token.publicKey,
    };
    const lwt = buildObserverStatusPayload('offline', identity);
    return {
      // Config completeness (brokerUrl/iataCode/tokenAudience all present) is
      // guaranteed by `observerConfigFromSource` before this publisher is ever
      // constructed (meshcoreManager only builds one when `observer` is
      // non-undefined) — non-null assert rather than threading a narrower
      // type through every read.
      url: this.options.config.brokerUrl!,
      username: `v1_${token.publicKey}`,
      password: token.token,
      clientIdPrefix: 'meshmonitor-observer',
      keepalive: 60,
      will: {
        topic: topics.status,
        payload: Buffer.from(JSON.stringify(lwt)),
        qos: 0,
        retain: true,
      },
    };
  }

  private wireClientListeners(client: MqttBrokerClient): void {
    client.on('connect', () => {
      this.lastError = null;
      this.authFailures = 0;
      void this.publishOnlineStatus();
    });
    client.on('error', (err: Error) => {
      // `MqttBrokerClient` emits BOTH `permission-denied` and a raw `error`
      // for the same CONNACK auth rejection (code 4/5), `permission-denied`
      // first. Skip here so the fixed, more actionable auth message from the
      // `permission-denied` listener below isn't clobbered by the raw
      // `err.message` (e.g. "Bad username or password").
      const code = (err as Error & { code?: number }).code;
      if (code === 4 || code === 5) return;
      this.lastError = redactToken(err.message);
    });
    client.on('permission-denied', (reason: PermissionDeniedReason) => {
      if (reason.kind !== 'auth') return;
      this.authFailures++;
      this.lastError = LAST_ERROR.authRejected;
      if (this.authFailures >= MAX_AUTH_FAILURES) {
        void this.hardStopOnAuthFailure();
      }
    });
  }

  /**
   * Read the device stats for a status publish (#4556). Never throws and never
   * blocks the status itself — a stats read that fails or times out degrades to
   * a status message with no `stats` key, which is exactly what a firmware
   * that doesn't report them would produce.
   */
  private async readStats(): Promise<ObserverStatsInput | null> {
    if (!this.options.stats) return null;
    try {
      return await this.options.stats();
    } catch (err) {
      logger.debug(
        `[MeshCoreObserver:${this.options.sourceId}] stats read failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Publish the retained `online` status. Async because the device stats it
   * carries cost a bridge round-trip; callers on the event path (`connect`)
   * fire-and-forget it.
   *
   * The client/topics are re-read AFTER the await — a token renewal or a stop
   * can swap or null them while the stats read is in flight, and publishing to
   * the stale client would either throw or write under the wrong credentials.
   *
   * The re-read is then CAPTURED into a local so the null-check and the
   * publish below see the same object. `stop()` nulls `this.client` before it
   * awaits the disconnect, so re-reading the field per use could pass the
   * check and then publish through a different (or absent) client. Worst case
   * we publish through a socket that is closing, which the `.catch` absorbs.
   */
  private async publishOnlineStatus(): Promise<void> {
    if (!this.client || !this.topics) return;

    const stats = await this.readStats();

    const client = this.client;
    const identity = this.getIdentity();
    if (!client || !identity || !this.topics) return;

    const dev = this.options.device();
    const payload = buildObserverStatusPayload('online', identity, {
      model: dev.model,
      firmwareVersion: dev.firmwareVersion,
      radio: dev.radio,
      clientVersion: `meshmonitor/${appVersion}`,
      stats,
    });
    await client
      .publish(this.topics.status, Buffer.from(JSON.stringify(payload)), true)
      .catch((err: unknown) => {
        this.lastError = redactToken(err instanceof Error ? err.message : String(err));
      });
  }

  private async connectWithToken(token: ObserverToken): Promise<void> {
    this.tokenPublicKey = token.publicKey;
    this.tokenExpiresAt = token.expiresAt;
    this.keyStored = true;
    this.topics = observerTopics(this.options.config.iataCode!, token.publicKey);

    const opts = this.buildClientOptions(token, this.topics);
    const client = this.createClientFn(opts);
    this.wireClientListeners(client);
    this.client = client;
    await client.connect();
  }

  /** D-9: mqtt.js bakes credentials in at CONNECT time — renewal tears down and rebuilds. */
  private async rebuildClientWithToken(token: ObserverToken): Promise<void> {
    const oldClient = this.client;
    this.client = null;
    if (oldClient) {
      try {
        await oldClient.disconnect();
      } catch {
        // Best-effort — proceed to bring the new client up regardless.
      }
    }
    await this.connectWithToken(token);
  }

  private armRenewalTimer(): void {
    this.clearRenewalTimer();
    this.renewalTimer = setInterval(() => {
      void this.checkRenewal();
    }, RENEWAL_CHECK_MS);
    this.renewalTimer.unref();
  }

  private clearRenewalTimer(): void {
    if (this.renewalTimer) {
      clearInterval(this.renewalTimer);
      this.renewalTimer = null;
    }
  }

  /**
   * Republish the retained `online` status every `STATUS_REFRESH_MS` so the
   * analyzer's battery / uptime / noise floor track the device instead of
   * freezing at their connect-time values (#4556).
   *
   * Deliberately a separate timer from the renewal one: renewal is hourly and
   * tears the socket down, while this is a cheap publish on the existing
   * socket. Folding the two would either make stats hourly or make renewal
   * five-minutely.
   */
  private armStatusRefreshTimer(): void {
    this.clearStatusRefreshTimer();
    this.statusRefreshTimer = setInterval(() => {
      void this.refreshStatus();
    }, STATUS_REFRESH_MS);
    this.statusRefreshTimer.unref();
  }

  private clearStatusRefreshTimer(): void {
    if (this.statusRefreshTimer) {
      clearInterval(this.statusRefreshTimer);
      this.statusRefreshTimer = null;
    }
  }

  /**
   * One refresh tick. Skips when the socket is down (a status publish to a
   * disconnected client would sit in mqtt.js's offline queue — the same
   * unbounded-queue hazard `handleOtaPacket` guards against) and latches so a
   * slow stats read can't stack ticks on a busy/unresponsive device.
   */
  private async refreshStatus(): Promise<void> {
    if (this.refreshingStatus) return;
    if (!this.client?.isConnected()) return;

    this.refreshingStatus = true;
    try {
      await this.publishOnlineStatus();
    } finally {
      this.refreshingStatus = false;
    }
  }

  /**
   * Renew when `nowSeconds >= tokenExpiresAt - (RENEWAL_CHECK_MS/1000 +
   * RENEWAL_THRESHOLD_S)`. The reference tests only the threshold on a
   * coarser interval, which leaves an expiry hole — see the module header
   * and spec §3.2/§6. Never hardcode the resulting window; always derive it
   * from the two constants.
   */
  private async checkRenewal(): Promise<void> {
    if (this.renewing || this.tokenExpiresAt === null) return;

    const nowSeconds = Math.floor(Date.now() / 1000);
    const windowSeconds = RENEWAL_CHECK_MS / 1000 + RENEWAL_THRESHOLD_S;
    if (nowSeconds < this.tokenExpiresAt - windowSeconds) return;

    this.renewing = true;
    try {
      const result = await this.mintTokenFn(this.options.sourceId);
      if (result.kind !== 'ok') {
        // Old client untouched — a transient mint failure must not tear down
        // a working connection. Retried automatically on the next tick.
        this.lastError = this.mintFailureMessage(result);
        return;
      }
      await this.rebuildClientWithToken(result.token);
    } finally {
      this.renewing = false;
    }
  }

  private async hardStopOnAuthFailure(): Promise<void> {
    if (this.authStopping) return;
    this.authStopping = true;
    this.clearRenewalTimer();
    this.clearStatusRefreshTimer();
    const client = this.client;
    this.client = null;
    this.running = false;
    if (client) {
      try {
        await client.disconnect();
      } catch {
        // Best-effort.
      }
    }
  }
}
