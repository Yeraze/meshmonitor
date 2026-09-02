/**
 * meshcoreObserverPublisher
 *
 * MeshCore Analyzer Observer publisher (#4457 Phase 2, WP4; multi-broker
 * #5014 Phase 1 WP3). One instance per MeshCore Companion source, owning N
 * `ObserverBrokerConnection`s — one per configured Analyzer broker. Mints
 * per-audience auth tokens (deduped across brokers that share an audience),
 * opens one authenticated, publish-only MQTT socket per broker to a
 * `michaelhart/meshcore-mqtt-broker`-compatible broker, relays every OTA
 * packet the radio hears (WP1's encoder) to every broker, and publishes
 * online/offline status to each. **Never subscribes to anything** — that is
 * this phase's headline invariant (see
 * `docs/internal/dev-notes/MESHCORE_OBSERVER_PHASE2_SPEC.md` §2.2, §9 WP4,
 * §10).
 *
 * Two auth modes (#4595), now per-broker (#5014):
 * - `token` (default): the original scheme — mint an Ed25519-signed token
 *   from the companion's signing key, username `v1_{PUBLIC_KEY}`, renewed on
 *   a timer. Minting is deduped BY AUDIENCE, not by broker: two brokers that
 *   share a `tokenAudience` share one WASM signature and one token.
 * - `password`: a STATIC MQTT username/password loaded from the encrypted
 *   credential store, for regional brokers (e.g. meshcoretel.ru) that verify
 *   no signature. Nothing expires, so there is NO renewal timer, and the
 *   topic public key comes from the node's own `get_self_info` rather than
 *   from a signing key. The password is decrypted HERE and nowhere else —
 *   it is never returned by a route and never written to `sources.config`.
 *
 * Design notes (see `MESHMAPPER_OBSERVER_PHASE1_SPEC.md` §3 for the full
 * derivation of the multi-broker shape; `MESHCORE_OBSERVER_PHASE2_SPEC.md`
 * §3.2/§6 for the single-broker renewal-window derivation that still applies
 * per audience):
 * - One publisher owns N `ObserverBrokerConnection`s rather than N publishers
 *   existing side by side. `stats()` costs a device round-trip and payload
 *   construction is on the packet hot path, so both are done ONCE per event
 *   and shared across every broker.
 * - Token minting happens at `start()` and again on a renewal timer — never
 *   per-packet. Minting is a WASM Ed25519 signature and is unaffordable at
 *   packet rate.
 * - mqtt.js bakes `username`/`password` into the CONNECT packet, so renewal
 *   tears down the affected connections and builds fresh ones with a fresh
 *   password and a fresh LWT (D-9) rather than trying to mutate an
 *   established connection.
 * - Backpressure: each connection gates on `client.isConnected()` itself and
 *   drops when the socket is down. mqtt.js queues QoS-0 publishes while
 *   offline by default, which would grow an unbounded in-memory queue on a
 *   busy mesh with a broker that's down — never let a publish reach a
 *   disconnected client.
 * - Auth-rejection cooldown: below `MAX_AUTH_FAILURES` we let the client's
 *   own backoff retry with the *same* token/credential (re-minting per
 *   attempt is the hot-loop we must avoid). At `MAX_AUTH_FAILURES` the
 *   OFFENDING CONNECTION hard-stops (disconnects and stays down until an
 *   operator-driven config change) — this is scoped to that one broker
 *   (#5014 deliberate behaviour change from the single-broker whole-publisher
 *   stop; see spec §3.2/§8.1). Only when every connection has hard-stopped do
 *   the publisher's timers clear and `isRunning()` go false.
 */
import { createRequire } from 'module';
import { MqttBrokerClient, type MqttBrokerClientOptions } from '../transports/mqttBrokerClient.js';
import { logger } from '../../utils/logger.js';
import type { OtaPacketEvent } from '../meshcoreVirtualNodeServer.js';
import type { MeshCoreConfig } from '../meshcoreManager.js';
import type { NormalizedObserverBroker } from '../meshcoreConfig.js';
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
// NOTE: value-imported deliberately — the credential store pulls in
// `services/database.js` only, NOT `meshcoreManager`, so there is no import
// cycle here (unlike `meshcoreConfig.js`, which meshcoreManager has to reach
// via a dynamic import for exactly that reason).
import {
  getMeshCoreObserverCredentialStore,
  type ObserverCredentialLoadResult,
} from './meshcoreObserverCredentialStore.js';
import type { MeshCoreObserverStatus, MeshCoreObserverBrokerStatus } from './meshcoreObserverStatus.js';

// Re-exported so every existing import site (`meshcoreManager.ts`, route
// handlers, tests) keeps working unchanged — the types themselves live in
// the dependency-free `meshcoreObserverStatus.ts` (#5014 Phase 1 WP1) so
// WP4's status route can depend on the shape without pulling this file (and
// its value imports of the credential store / token minter / package.json)
// in.
export type { MeshCoreObserverStatus, MeshCoreObserverBrokerStatus } from './meshcoreObserverStatus.js';

// createRequire interop for package.json, same pattern as newsService.ts.
const require = createRequire(import.meta.url);
const appVersion: string = require('../../../package.json').version;

/** Re-check a token's remaining life once an hour. */
export const RENEWAL_CHECK_MS = 3_600_000;
/**
 * Safety margin (seconds) folded on top of `RENEWAL_CHECK_MS` when deciding
 * whether to renew. See the module header / spec §3.2 for why the check
 * interval itself must be part of the window, not just this margin.
 */
export const RENEWAL_THRESHOLD_S = 300;
/** Consecutive CONNACK auth rejections before a connection hard-stops. */
export const MAX_AUTH_FAILURES = 5;
/**
 * How often the retained `online` status is republished with fresh device
 * stats (#4556). Matches `meshcoretomqtt`'s 5-minute stats loop, so battery /
 * uptime / noise floor on the analyzer track the device instead of freezing
 * at their connect-time values. Each tick costs two local bridge commands
 * (`get_stats core` + `radio`) — no RF, so it is safe on a fixed interval,
 * and is read exactly ONCE per tick regardless of how many brokers are
 * configured (#5014 §3.1).
 */
export const STATUS_REFRESH_MS = 300_000;

/** Strips anything shaped like a minted observer token (or a JWT-style secret) from a message. */
const TOKEN_SHAPE_PATTERN = /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[0-9A-Fa-f]{128}/g;

/** Never let a token/password-shaped substring escape into a user-visible `lastError`. Module-level and
 *  shared by every `ObserverBrokerConnection` — NOT duplicated per connection (#5014 spec §3.2). */
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
  // Static-credential (#4595) variants.
  noCredentials: 'No broker username/password stored for this source.',
  credentialsRotated:
    'Stored broker password cannot be decrypted (SESSION_SECRET changed). Re-enter the password.',
  noPublicKey:
    'The node has not reported its public key yet, so the observer topic cannot be built. Reconnect the source.',
  authRejectedStatic: 'Broker rejected the observer username/password.',
} as const;

/** Monotonic sequence for "most recently set" `lastError` aggregation (§5.1). Shared across every
 *  connection/publisher in the process — only the relative order matters, never the absolute value. */
let lastErrorSequence = 0;

export interface MeshCoreObserverPublisherOptions {
  sourceId: string;
  config: NonNullable<MeshCoreConfig['observer']>;
  /** Live device facts, read lazily at publish/status time — never cached at construction. */
  device: () => {
    origin: string;
    model?: string;
    firmwareVersion?: string;
    radio?: string;
    /**
     * The node's own 32-byte public key hex, from `get_self_info` (#4595).
     * NOT secret. Only consulted in `password` auth mode, where there is no
     * signing key to derive it from but the topic path and `origin_id` still
     * need it. In `token` mode the minted token's public key wins.
     */
    publicKey?: string;
  };
  /**
   * Live battery / uptime / noise-floor stats read off the attached companion
   * (#4556). Async because it costs a bridge round-trip, so it is only ever
   * called on the status path — never per-packet. Optional: a source that
   * can't supply stats simply publishes a status with no `stats` key.
   * Must resolve, not reject; a rejection is caught and treated as "no stats".
   */
  stats?: () => Promise<ObserverStatsInput | null>;
  /**
   * Injection seam for tests (#5014: WIDENED — audience is now explicit,
   * because brokers differ). Defaults to
   * `(id, aud) => mintObserverTokenForSourceDetailed(id, aud)`.
   */
  mintToken?: (sourceId: string, audience: string) => Promise<ObserverTokenResult>;
  /**
   * Injection seam for tests (#4595; #5014: WIDENED to a per-broker key plus
   * the legacy-fallback flag). Only called in `password` auth mode. Defaults
   * to `resolveBrokerCredential` (module-local, below).
   */
  loadCredentials?: (
    sourceId: string,
    brokerKey: string,
    legacy: boolean,
  ) => Promise<ObserverCredentialLoadResult>;
  /** Injection seam for tests. Defaults to `(opts) => new MqttBrokerClient(opts)`. */
  createClient?: (opts: MqttBrokerClientOptions) => MqttBrokerClient;
}

/** Minimal shape of the `permission-denied` event `MqttBrokerClient` emits. */
interface PermissionDeniedReason {
  kind: 'subscribe' | 'auth';
  topics?: string[];
  message: string;
}

/**
 * Default `loadCredentials` (#5014 spec §4.3). A per-broker credential always
 * wins over the legacy one; only the LEGACY broker (the one derived from — or
 * matching — the pre-#5014 top-level `brokerUrl`) falls back to the old
 * single-credential row when it has no per-broker entry of its own. A
 * non-legacy broker NEVER sees the legacy credential — that is the
 * per-broker isolation guarantee.
 */
async function resolveBrokerCredential(
  sourceId: string,
  brokerKey: string,
  legacy: boolean,
): Promise<ObserverCredentialLoadResult> {
  const store = getMeshCoreObserverCredentialStore();
  const perBroker = await store.loadForBroker(sourceId, brokerKey);
  if (perBroker.kind !== 'none' || !legacy) return perBroker;
  return store.load(sourceId);
}

/** Everything a connection needs to resolve before it can open a socket. */
type ResolvedCredential =
  | { kind: 'ok'; username: string; password: string; publicKey: string; tokenExpiresAt: number | null }
  | { kind: 'error'; message: string; keyStored: boolean };

/** Constructor deps for {@link ObserverBrokerConnection}, supplied by the owning publisher. */
interface BrokerConnectionDeps {
  sourceId: string;
  iataCode: string;
  device: MeshCoreObserverPublisherOptions['device'];
  /**
   * Reads device stats for THIS connection's own connect-triggered online
   * status publish (unchanged single-broker behaviour: a socket republishes
   * its retained status the moment it connects, whether that is the initial
   * `start()` or a post-renewal rebuild). This is intentionally a SEPARATE
   * call path from the publisher's shared `STATUS_REFRESH_MS` tick, which
   * reads stats exactly once centrally and hands the result to every
   * connected connection directly via `publishOnlineStatus()` — see
   * `MeshCoreObserverPublisher.refreshStatus()`. A connect event is not a
   * refresh tick, so it is not bound by "stats() called at most once per
   * tick".
   */
  readStats: () => Promise<ObserverStatsInput | null>;
  createClient: (opts: MqttBrokerClientOptions) => MqttBrokerClient;
  /** Called when this connection hard-stops on repeated auth rejection. */
  onAuthHardStop: (key: string) => void;
}

/**
 * Owns everything that is per-broker: the MQTT client, topics, counters, and
 * auth-failure state (#5014 spec §3.2). Never throws out of any public
 * method. A structural sibling of `MqttBridgePublisherPool`'s `PoolEntry`
 * (client + publishes + lastPublishAt + lastError), kept private to this
 * file rather than generalized — see spec §1.3 for why a shared abstraction
 * with that pool is not worth it.
 */
class ObserverBrokerConnection {
  readonly key: string;
  readonly broker: NormalizedObserverBroker;
  private readonly deps: BrokerConnectionDeps;

  private client: MqttBrokerClient | null = null;
  private topics: { region: string; packets: string; status: string } | null = null;
  private tokenPublicKey: string | null = null;

  private keyStored = false;
  private publishes = 0;
  private dropped = 0;
  private lastPublishAt: number | null = null;
  private lastError: string | null = null;
  private lastErrorSeq = 0;
  private tokenExpiresAt: number | null = null;

  private authFailures = 0;
  private authStopping = false;

  constructor(broker: NormalizedObserverBroker, deps: BrokerConnectionDeps) {
    this.broker = broker;
    this.key = broker.key;
    this.deps = deps;
  }

  /** Topic public key for this connection, or null before a successful start. */
  get originId(): string | null {
    return this.tokenPublicKey;
  }

  isConnected(): boolean {
    return this.client?.isConnected() ?? false;
  }

  /** Exposed for the publisher's "most recently set" `lastError` aggregate (§5.1). Not part of the
   *  public status shape — purely an internal ordering key. */
  getLastErrorSeq(): number {
    return this.lastErrorSeq;
  }

  /** Record an error originating OUTSIDE this connection (e.g. a renewal mint failure for this
   *  connection's audience) without touching its socket. Public because the owning publisher, not
   *  this connection itself, observes that failure. */
  recordExternalError(message: string): void {
    this.recordError(message);
  }

  /** Connect with a resolved credential. Records failures in `lastError`; never throws. */
  async start(cred: ResolvedCredential): Promise<void> {
    // Reset the auth-failure state so a fresh start (e.g. a new instance
    // reused in tests, or any future restart path) is never poisoned by a
    // prior hard-stop — the guard is a concurrency latch, not a permanent
    // fuse (review #4468 obs. 4).
    this.authStopping = false;
    this.authFailures = 0;

    if (cred.kind === 'error') {
      this.keyStored = cred.keyStored;
      this.recordError(cred.message);
      return;
    }

    this.tokenExpiresAt = cred.tokenExpiresAt;
    await this.openSocket(cred.username, cred.password, cred.publicKey);
  }

  /** Publish offline status (best-effort) then disconnect({ flush: true }). Idempotent. */
  async stop(): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.client = null;

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
      // flushed, silently dropping the graceful-stop offline status.
      await client.disconnect({ flush: true });
    } catch {
      // Best-effort.
    }
  }

  /**
   * Sync, never throws. Drops (dropped++) when the socket is down. Takes a
   * PRE-SERIALIZED buffer so the caller (the publisher) can build the
   * payload once per distinct `originId` and share it across every broker on
   * that origin (#5014 §3.3).
   */
  publishPacket(payload: Buffer): void {
    const client = this.client;
    if (!client || !client.isConnected() || !this.topics) {
      this.dropped++;
      return;
    }

    void client
      .publish(this.topics.packets, payload, false)
      .then(() => {
        this.publishes++;
        this.lastPublishAt = Date.now();
      })
      .catch((err: unknown) => {
        this.recordError(redactToken(err instanceof Error ? err.message : String(err)));
      });
  }

  /**
   * A packet arrived but this connection never successfully started (no
   * `originId` yet) — count it as dropped, matching today's single-broker
   * behaviour when `tokenPublicKey` is null.
   */
  noteDropped(): void {
    this.dropped++;
  }

  /**
   * Publish the retained `online` status with the CALLER's already-read
   * stats — see `BrokerConnectionDeps.readStats` for why there are two
   * distinct call paths into this method (a connect event vs. the shared
   * refresh tick).
   *
   * The client/topics are re-read at call time — a token renewal or a stop
   * can swap or null them between when the caller read stats and when it
   * calls this, and publishing to the stale client would either throw or
   * write under the wrong credentials.
   */
  async publishOnlineStatus(stats: ObserverStatsInput | null): Promise<void> {
    const client = this.client;
    const identity = this.getIdentity();
    if (!client || !identity || !this.topics) return;

    const dev = this.deps.device();
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
        this.recordError(redactToken(err instanceof Error ? err.message : String(err)));
      });
  }

  /** Tear down and reconnect with a fresh token (D-9: mqtt.js bakes creds into CONNECT). */
  async rebuildWithToken(token: ObserverToken): Promise<void> {
    const oldClient = this.client;
    this.client = null;
    if (oldClient) {
      try {
        await oldClient.disconnect();
      } catch {
        // Best-effort — proceed to bring the new client up regardless.
      }
    }
    this.tokenExpiresAt = token.expiresAt;
    await this.openSocket(`v1_${token.publicKey}`, token.token, token.publicKey);
  }

  getStatus(): MeshCoreObserverBrokerStatus {
    return {
      key: this.key,
      url: this.broker.url,
      label: this.broker.label ?? null,
      authMode: this.broker.authMode,
      tokenAudience: this.broker.tokenAudience ?? null,
      // Every entry in `config.brokers` already passed `normalizeObserverBrokers`'s
      // per-mode completeness rule (token mode requires a tokenAudience,
      // password mode requires nothing extra) — so a constructed connection
      // is by definition "configured" for its own auth mode.
      configured: true,
      keyStored: this.keyStored,
      connected: this.isConnected(),
      publishes: this.publishes,
      dropped: this.dropped,
      lastPublishAt: this.lastPublishAt,
      lastError: this.lastError,
      tokenExpiresAt: this.tokenExpiresAt,
    };
  }

  // ── internals ────────────────────────────────────────────────────────

  private recordError(message: string): void {
    this.lastError = message;
    this.lastErrorSeq = ++lastErrorSequence;
  }

  private getIdentity(): ObserverPacketIdentity | null {
    if (!this.tokenPublicKey) return null;
    return { origin: this.deps.device().origin, originId: this.tokenPublicKey };
  }

  private buildClientOptions(
    credentials: { username: string; password: string; publicKey: string },
    topics: { status: string },
  ): MqttBrokerClientOptions {
    const identity: ObserverPacketIdentity = {
      origin: this.deps.device().origin,
      originId: credentials.publicKey,
    };
    const lwt = buildObserverStatusPayload('offline', identity);
    return {
      url: this.broker.url,
      username: credentials.username,
      password: credentials.password,
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
      void this.publishOnlineStatusOnConnect();
    });
    client.on('error', (err: Error) => {
      // `MqttBrokerClient` emits BOTH `permission-denied` and a raw `error`
      // for the same CONNACK auth rejection (code 4/5), `permission-denied`
      // first. Skip here so the fixed, more actionable auth message from the
      // `permission-denied` listener below isn't clobbered by the raw
      // `err.message` (e.g. "Bad username or password").
      const code = (err as Error & { code?: number }).code;
      if (code === 4 || code === 5) return;
      this.recordError(redactToken(err.message));
    });
    client.on('permission-denied', (reason: PermissionDeniedReason) => {
      if (reason.kind !== 'auth') return;
      this.authFailures++;
      this.recordError(
        this.broker.authMode === 'password' ? LAST_ERROR.authRejectedStatic : LAST_ERROR.authRejected,
      );
      if (this.authFailures >= MAX_AUTH_FAILURES) {
        void this.hardStopOnAuthFailure();
      }
    });
  }

  private async publishOnlineStatusOnConnect(): Promise<void> {
    const stats = await this.deps.readStats();
    await this.publishOnlineStatus(stats);
  }

  /** Shared connect tail for both auth modes AND for renewal rebuilds. Never throws — a
   *  `createClient` seam that throws (test-injected or otherwise) fails this connection closed
   *  without taking down the others (#5014 §3.3 "start() never throws"). */
  private async openSocket(username: string, password: string, publicKey: string): Promise<void> {
    this.tokenPublicKey = publicKey;
    this.keyStored = true;
    this.topics = observerTopics(this.deps.iataCode, publicKey);

    const opts = this.buildClientOptions({ username, password, publicKey }, this.topics);
    let client: MqttBrokerClient;
    try {
      client = this.deps.createClient(opts);
    } catch (err) {
      this.recordError(redactToken(err instanceof Error ? err.message : String(err)));
      this.keyStored = false;
      this.tokenPublicKey = null;
      this.topics = null;
      return;
    }
    this.wireClientListeners(client);
    this.client = client;
    await client.connect();
  }

  private async hardStopOnAuthFailure(): Promise<void> {
    if (this.authStopping) return;
    this.authStopping = true;
    const client = this.client;
    this.client = null;
    if (client) {
      try {
        await client.disconnect();
      } catch {
        // Best-effort.
      }
    }
    this.deps.onAuthHardStop(this.key);
  }
}

export class MeshCoreObserverPublisher {
  private readonly options: MeshCoreObserverPublisherOptions;
  private readonly mintTokenFn: (sourceId: string, audience: string) => Promise<ObserverTokenResult>;
  private readonly loadCredentialsFn: (
    sourceId: string,
    brokerKey: string,
    legacy: boolean,
  ) => Promise<ObserverCredentialLoadResult>;
  private readonly createClientFn: (opts: MqttBrokerClientOptions) => MqttBrokerClient;

  /** One connection per `config.brokers` entry, built once at construction so `getStatus()` is
   *  well-defined even before `start()` is ever called (mirrors the pre-#5014 single-broker
   *  publisher, whose `configured` was always computable from the constructor alone). */
  private readonly connections: ObserverBrokerConnection[];
  /** audience -> current token. Only audiences with at least one successfully-minted token. */
  private tokensByAudience = new Map<string, ObserverToken>();
  /** Connection keys that have hard-stopped on repeated auth failure since the last `start()`. */
  private readonly hardStoppedKeys = new Set<string>();

  private running = false;
  private renewing = false;
  private renewalTimer: ReturnType<typeof setInterval> | null = null;
  private statusRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshingStatus = false;

  constructor(options: MeshCoreObserverPublisherOptions) {
    this.options = options;
    this.mintTokenFn = options.mintToken ?? ((sourceId, audience) => mintObserverTokenForSourceDetailed(sourceId, audience));
    this.loadCredentialsFn =
      options.loadCredentials ?? ((sourceId, brokerKey, legacy) => resolveBrokerCredential(sourceId, brokerKey, legacy));
    this.createClientFn = options.createClient ?? ((opts) => new MqttBrokerClient(opts));

    this.connections = options.config.brokers.map(
      (broker) =>
        new ObserverBrokerConnection(broker, {
          sourceId: options.sourceId,
          iataCode: options.config.iataCode,
          device: options.device,
          readStats: () => this.readStats(),
          createClient: this.createClientFn,
          onAuthHardStop: (key) => this.onConnectionAuthHardStop(key),
        }),
    );
  }

  /**
   * Mint/load credentials for every broker → connect every socket → publish
   * each one's online status. Resolves even on total failure — the failure
   * reason(s) land in `getStatus().brokers[i].lastError`, never a thrown
   * error (#5014 §3.3).
   */
  async start(): Promise<void> {
    this.hardStoppedKeys.clear();

    if (this.connections.length === 0) {
      this.running = false;
      return;
    }

    const credByKey = new Map<string, ResolvedCredential>();
    await this.resolveTokenCredentials(credByKey);
    await this.resolvePasswordCredentials(credByKey);

    const results = await Promise.allSettled(
      this.connections.map((c) =>
        c.start(credByKey.get(c.key) ?? { kind: 'error', message: LAST_ERROR.notConfigured, keyStored: false }),
      ),
    );
    for (const r of results) {
      if (r.status === 'rejected') {
        logger.debug(`[MeshCoreObserver:${this.options.sourceId}] connection start rejected: ${String(r.reason)}`);
      }
    }

    // "Constructed" (spec §3.3 point 6) means a connection actually attempted
    // to open a socket, i.e. its credential resolved — not merely that an
    // `ObserverBrokerConnection` object exists. This preserves the
    // pre-#5014 single-broker contract: a total mint/credential failure
    // leaves the publisher NOT running and arms no timers.
    const anyOk = Array.from(credByKey.values()).some((c) => c.kind === 'ok');
    if (anyOk) {
      if (this.tokensByAudience.size > 0) this.armRenewalTimer();
      this.armStatusRefreshTimer();
    }
    this.running = anyOk;
  }

  /** Publish an explicit offline status on every broker, then disconnect. Idempotent. */
  async stop(): Promise<void> {
    this.clearRenewalTimer();
    this.clearStatusRefreshTimer();
    this.running = false;
    this.hardStoppedKeys.clear();
    await Promise.allSettled(this.connections.map((c) => c.stop()));
  }

  /**
   * Sync, never throws. Call from the manager's `ota_packet` listener. No
   * token minting on this path — see the module header. Groups connections
   * by `originId` so the packet payload is `JSON.stringify`-ed exactly ONCE
   * per distinct origin, then shared as one `Buffer` across every broker on
   * that origin (#5014 §3.3) — in practice there is exactly one group, since
   * every connection on a source derives the same origin (one signing key in
   * token mode, one node public key in password mode).
   */
  handleOtaPacket(event: OtaPacketEvent): void {
    const groups = new Map<string, ObserverBrokerConnection[]>();
    for (const c of this.connections) {
      const originId = c.originId;
      if (!originId) {
        // Never successfully started — matches today's behaviour when
        // `tokenPublicKey` is null.
        c.noteDropped();
        continue;
      }
      const arr = groups.get(originId);
      if (arr) arr.push(c);
      else groups.set(originId, [c]);
    }

    for (const [originId, conns] of groups) {
      const identity: ObserverPacketIdentity = { origin: this.options.device().origin, originId };
      const payload = buildObserverPacketPayload(event, identity);
      if (!payload) continue; // blank/missing raw_hex — mirrors VN handleOtaPacket.
      const buf = Buffer.from(JSON.stringify(payload));
      for (const c of conns) c.publishPacket(buf);
    }
  }

  /**
   * Aggregate status (#5014 §5.1). Every field below `brokers` is chosen so
   * a single-broker source reports EXACTLY the values it reported pre-#5014:
   * SUM for counters, MAX for `lastPublishAt`, MIN (non-null) for
   * `tokenExpiresAt`, ANY for the booleans, and the most-recently-set
   * non-null `lastError`.
   */
  getStatus(): MeshCoreObserverStatus {
    const brokers = this.connections.map((c) => c.getStatus());
    return {
      configured: brokers.some((b) => b.configured),
      authMode: brokers[0]?.authMode ?? this.options.config.authMode,
      keyStored: brokers.some((b) => b.keyStored),
      connected: brokers.some((b) => b.connected),
      publishes: brokers.reduce((sum, b) => sum + b.publishes, 0),
      dropped: brokers.reduce((sum, b) => sum + b.dropped, 0),
      lastPublishAt: reduceNullable(brokers.map((b) => b.lastPublishAt), (a, b) => (a > b ? a : b)),
      lastError: this.aggregateLastError(),
      tokenExpiresAt: reduceNullable(brokers.map((b) => b.tokenExpiresAt), (a, b) => (a < b ? a : b)),
      brokers,
    };
  }

  isRunning(): boolean {
    return this.running;
  }

  // ── internals ──────────────────────────────────────────────────────────

  private aggregateLastError(): string | null {
    let best: { message: string; seq: number } | null = null;
    for (const c of this.connections) {
      const message = c.getStatus().lastError;
      if (message === null) continue;
      const seq = c.getLastErrorSeq();
      if (!best || seq > best.seq) best = { message, seq };
    }
    return best?.message ?? null;
  }

  /**
   * Mint (or reuse) one token per DISTINCT audience among the token-mode
   * connections, then fan the result out to every connection on that
   * audience (#5014 §3.3/§3.4). A failed mint marks every connection on that
   * audience with the mapped `LAST_ERROR` message and `keyStored: false`.
   */
  private async resolveTokenCredentials(credByKey: Map<string, ResolvedCredential>): Promise<void> {
    const tokenConnections = this.connections.filter((c) => c.broker.authMode === 'token');
    if (tokenConnections.length === 0) {
      this.tokensByAudience = new Map();
      return;
    }

    const audiences = Array.from(new Set(tokenConnections.map((c) => c.broker.tokenAudience!)));
    const settled = await Promise.allSettled(
      audiences.map(async (aud) => ({ aud, result: await this.mintTokenFn(this.options.sourceId, aud) })),
    );

    const tokenByAudience = new Map<string, ObserverToken>();
    const errorByAudience = new Map<string, string>();
    for (const outcome of settled) {
      if (outcome.status === 'rejected') {
        logger.debug(`[MeshCoreObserver:${this.options.sourceId}] token mint rejected: ${String(outcome.reason)}`);
        continue;
      }
      const { aud, result } = outcome.value;
      if (result.kind === 'ok') {
        tokenByAudience.set(aud, result.token);
      } else {
        errorByAudience.set(aud, this.mintFailureMessage(result));
      }
    }
    this.tokensByAudience = tokenByAudience;

    for (const c of tokenConnections) {
      const aud = c.broker.tokenAudience!;
      const token = tokenByAudience.get(aud);
      if (token) {
        credByKey.set(c.key, {
          kind: 'ok',
          username: `v1_${token.publicKey}`,
          password: token.token,
          publicKey: token.publicKey,
          tokenExpiresAt: token.expiresAt,
        });
      } else {
        credByKey.set(c.key, {
          kind: 'error',
          message: errorByAudience.get(aud) ?? LAST_ERROR.mintFailed,
          keyStored: false,
        });
      }
    }
  }

  /** Load each password-mode connection's own credential (#5014 §3.3/§4.3). */
  private async resolvePasswordCredentials(credByKey: Map<string, ResolvedCredential>): Promise<void> {
    const passwordConnections = this.connections.filter((c) => c.broker.authMode === 'password');
    if (passwordConnections.length === 0) return;

    const publicKey = this.options.device().publicKey;
    await Promise.allSettled(
      passwordConnections.map(async (c) => {
        if (!publicKey) {
          credByKey.set(c.key, { kind: 'error', message: LAST_ERROR.noPublicKey, keyStored: true });
          return;
        }
        const creds = await this.loadCredentialsFn(this.options.sourceId, c.key, c.broker.legacy);
        if (creds.kind !== 'ok') {
          credByKey.set(c.key, {
            kind: 'error',
            message: creds.kind === 'none' ? LAST_ERROR.noCredentials : LAST_ERROR.credentialsRotated,
            keyStored: false,
          });
          return;
        }
        credByKey.set(c.key, {
          kind: 'ok',
          username: creds.username,
          password: creds.password,
          publicKey,
          tokenExpiresAt: null,
        });
      }),
    );
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
   * Republish the retained `online` status on every CONNECTED broker every
   * `STATUS_REFRESH_MS`, reading device stats exactly ONCE and sharing the
   * result (#4556, #5014 §3.3). Skips entirely when nothing is connected
   * (preserves the "never let a publish reach a disconnected client"
   * invariant) and latches so a slow stats read can't stack ticks on a
   * busy/unresponsive device.
   */
  private async refreshStatus(): Promise<void> {
    if (this.refreshingStatus) return;
    const connected = this.connections.filter((c) => c.isConnected());
    if (connected.length === 0) return;

    this.refreshingStatus = true;
    try {
      const stats = await this.readStats();
      await Promise.allSettled(connected.map((c) => c.publishOnlineStatus(stats)));
    } finally {
      this.refreshingStatus = false;
    }
  }

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
   * Renew when `nowSeconds >= tokenExpiresAt - (RENEWAL_CHECK_MS/1000 +
   * RENEWAL_THRESHOLD_S)`, per DISTINCT audience — never hardcode the
   * resulting window; always derive it from the two constants (see the
   * module header / spec §3.2/§6 for why the check interval itself must be
   * part of the window). Only the audiences that need renewal are re-minted;
   * only the connections on those audiences are rebuilt (#5014 §3.3).
   */
  private async checkRenewal(): Promise<void> {
    if (this.renewing) return;

    const nowSeconds = Math.floor(Date.now() / 1000);
    const windowSeconds = RENEWAL_CHECK_MS / 1000 + RENEWAL_THRESHOLD_S;
    const dueAudiences = Array.from(this.tokensByAudience.entries())
      .filter(([, token]) => nowSeconds >= token.expiresAt - windowSeconds)
      .map(([aud]) => aud);
    if (dueAudiences.length === 0) return;

    this.renewing = true;
    try {
      await Promise.allSettled(dueAudiences.map((aud) => this.renewAudience(aud)));
    } finally {
      this.renewing = false;
    }
  }

  private async renewAudience(audience: string): Promise<void> {
    // Exclude hard-stopped connections: a connection that hit
    // MAX_AUTH_FAILURES is disconnected on purpose and its `authStopping`
    // latch stays set until an operator-driven config change / reconnect
    // (start()). Renewing its token and calling rebuildWithToken() would
    // resurrect the socket and, because the latch is already set,
    // hardStopOnAuthFailure() would early-return forever after -- the
    // connection would then retry via mqtt.js's own backoff with NO way to
    // hard-stop again. Skip it entirely, and skip minting altogether when
    // every connection on this audience is dead (no point burning an hourly
    // WASM signature for a token nothing will use).
    const affected = this.connections.filter(
      (c) =>
        c.broker.authMode === 'token' &&
        c.broker.tokenAudience === audience &&
        !this.hardStoppedKeys.has(c.key),
    );
    if (affected.length === 0) return;

    const result = await this.mintTokenFn(this.options.sourceId, audience);
    if (result.kind !== 'ok') {
      // Old sockets untouched — a transient mint failure must not tear down
      // a working connection. Retried automatically on the next tick.
      const message = this.mintFailureMessage(result);
      for (const c of affected) c.recordExternalError(message);
      return;
    }
    this.tokensByAudience.set(audience, result.token);
    await Promise.allSettled(affected.map((c) => c.rebuildWithToken(result.token)));
  }

  private onConnectionAuthHardStop(key: string): void {
    this.hardStoppedKeys.add(key);
    const allStopped =
      this.connections.length > 0 && this.connections.every((c) => this.hardStoppedKeys.has(c.key));
    if (allStopped) {
      this.clearRenewalTimer();
      this.clearStatusRefreshTimer();
      this.running = false;
    }
  }
}

/** Reduce a list of nullable numbers, ignoring nulls; null if every value is null. */
function reduceNullable(values: Array<number | null>, pick: (a: number, b: number) => number): number | null {
  let result: number | null = null;
  for (const v of values) {
    if (v === null) continue;
    result = result === null ? v : pick(result, v);
  }
  return result;
}
