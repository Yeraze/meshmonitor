/**
 * MeshCoreMqttBrokerManager — the embedded MeshCore MQTT broker source
 * (`meshcore_mqtt_broker`, #6197).
 *
 * MeshCore observers (repeaters, Companion observers) publish straight to
 * MeshMonitor on the Analyzer topic layout, `meshcore/{IATA}/{PUBKEY}/packets`
 * and `/status`, instead of through an external broker. Accepted frames feed
 * the SAME ingest pipeline as a `meshcore_mqtt` source: this class extends
 * {@link MeshCoreMqttManager} and only swaps the transport, so Packet Monitor,
 * node discovery, channel decrypt and observer stats need no new code.
 *
 * Radio-less: it never transmits on RF. Load is capped by the limits below,
 * and upstream forwarding (MQTT only) carries only frames that passed them.
 *
 * Binding v1 decisions (issue #6197 comment):
 * 1. Its own source type; read gates use predicates, not string widening.
 * 2. Auth: a valid Ed25519 token (audience must match) from an allowlisted
 *    observer key, or the static username/password. Anonymous is refused.
 *    The allowlist binds every login: a static login may only publish under
 *    an allowlisted key.
 * 3. A token login may only publish under its own key in the topic.
 * 4. Limits: max clients, msg/s per connection (excess dropped and counted),
 *    max payload.
 * 5. Per-connection diagnostics: last topic and last reject reason.
 * 6. Opt-in upstream forwarding, see meshcoreMqttBrokerForwarder.ts.
 * 7. No WebSocket listener in v1.
 *
 * The rate counters and diagnostics are in memory on purpose. They are display
 * counters, not safety timers: nothing here sends on RF, and a restart that
 * zeroes them re-arms nothing.
 */
import crypto from 'node:crypto';
import type { Client } from 'aedes';
import { verifyAuthToken } from '@michaelhart/meshcore-decoder';
import { MeshCoreMqttManager, type MeshCoreMqttSourceStatus } from './meshcoreMqttManager.js';
import { MeshCoreMqttBroker, type MeshCoreBrokerAuthDecision } from './transports/meshcoreMqttBroker.js';
import {
  decodeObserverPacketMessageDetailed,
  decodeObserverStatusMessage,
  type ObserverPacketRejectReason,
} from './services/meshcoreMqttIngestPacket.js';
import {
  normalizeMeshCoreBrokerConfig,
  IATA_RE,
  OBSERVER_KEY_RE,
  type NormalizedMeshCoreBrokerConfig,
} from './services/meshcoreMqttBrokerConfig.js';
import {
  MeshCoreBrokerForwarder,
  type ForwardTargetStatus,
  type OwnIdentityKey,
} from './services/meshcoreMqttBrokerForwarder.js';
import { getMeshCoreObserverKeyStore } from './services/meshcoreObserverKeyStore.js';
import { deriveObserverPublicKey } from './services/meshcoreObserverToken.js';
import { logger } from '../utils/logger.js';

/** Why the broker refused a login or dropped a publish. Shown on the source card. */
export type BrokerRejectReason =
  | 'auth_bad_credentials'
  | 'auth_not_allowlisted'
  | 'auth_bad_token'
  | 'auth_bad_audience'
  | 'auth_own_identity'
  | 'max_clients'
  | 'rate'
  | 'payload_too_large'
  | 'bad_topic'
  | 'bad_region'
  | 'key_mismatch'
  | 'bad_json'
  | 'bad_status'
  | 'loop'
  | 'not_allowlisted'
  | ObserverPacketRejectReason;

export interface BrokerConnectionDiagnostics {
  clientId: string;
  remoteAddress: string | null;
  authMode: 'token' | 'static';
  /** Token key for a token login; the last topic key for a static login. */
  observerKey: string | null;
  connectedAt: number;
  received: number;
  accepted: number;
  rejected: number;
  rateDropped: number;
  lastTopic: string | null;
  lastMessageAt: number | null;
  lastRejectReason: BrokerRejectReason | null;
  lastRejectAt: number | null;
}

export interface BrokerRecentEvent {
  at: number;
  kind: 'auth_rejected' | 'disconnected';
  clientId: string;
  remoteAddress: string | null;
  observerKey: string | null;
  reason: BrokerRejectReason | null;
}

export interface MeshCoreBrokerDiagnostics {
  listening: boolean;
  port: number | null;
  clientCount: number;
  lastError: string | null;
  limits: { maxClients: number; maxMessagesPerSecond: number; maxPayloadBytes: number };
  regions: string[];
  tokenAuth: boolean;
  staticAuth: boolean;
  allowedObserverCount: number;
  ownIdentityPublicKey: string | null;
  totals: { received: number; accepted: number; rejected: number; rateDropped: number; authRejected: number };
  connections: BrokerConnectionDiagnostics[];
  recent: BrokerRecentEvent[];
  forwarding: ForwardTargetStatus[];
}

export interface MeshCoreMqttBrokerSourceStatus extends MeshCoreMqttSourceStatus {
  /** Observers connected right now. */
  clientCount: number;
}

interface ConnectionState extends BrokerConnectionDiagnostics {
  windowStart: number;
  windowCount: number;
}

/** How long a forwarded payload is remembered for the loop guard. */
const LOOP_MEMORY_MS = 120_000;
const LOOP_MEMORY_MAX = 5_000;
const RECENT_MAX = 25;
const TOKEN_USERNAME_RE = /^v1_([0-9a-fA-F]{64})$/;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Same-length dummy compare against the stored value keeps the timing flat.
    crypto.timingSafeEqual(Buffer.alloc(bb.length), bb);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

function payloadDigest(payload: Buffer): string {
  return crypto.createHash('sha256').update(payload).digest('base64');
}

export class MeshCoreMqttBrokerManager extends MeshCoreMqttManager {
  override readonly sourceType = 'meshcore_mqtt_broker' as const;

  private readonly brokerConfig: NormalizedMeshCoreBrokerConfig;
  private broker: MeshCoreMqttBroker | null = null;
  private forwarder: MeshCoreBrokerForwarder | null = null;
  private ownKey: OwnIdentityKey | null = null;
  private readonly live = new Map<Client, ConnectionState>();
  private readonly pending = new WeakMap<Client, ConnectionState>();
  private readonly recent: BrokerRecentEvent[] = [];
  private readonly forwardedDigests = new Map<string, number>();
  private readonly totals = { received: 0, accepted: 0, rejected: 0, rateDropped: 0, authRejected: 0 };
  private lastBrokerError: string | null = null;

  /** Test seam: a fixed port override (0 = ephemeral). */
  private readonly portOverride: number | null;

  constructor(sourceId: string, sourceName: string, rawConfig: unknown, opts?: { portOverride?: number }) {
    // The base class's broker URL / region describe an outbound client; this
    // source has none. getFeedEndpoint() is overridden below.
    super(sourceId, sourceName, { brokerUrl: '', region: '' });
    this.brokerConfig = normalizeMeshCoreBrokerConfig(rawConfig);
    this.portOverride = opts?.portOverride ?? null;
  }

  /** The broker config's own-node observer (#6532); see the base class. */
  override getLocalObserverKey(): string | null {
    return this.brokerConfig.localObserverKey;
  }

  protected override async openTransport(): Promise<void> {
    this.ownKey = await this.loadOwnKey();
    const cfg = this.brokerConfig;
    const broker = new MeshCoreMqttBroker({
      port: this.portOverride ?? cfg.port,
      host: cfg.host,
      brokerId: `meshmonitor-mc-${this.sourceId}`,
      maxPayloadBytes: cfg.maxPayloadBytes,
      authenticate: (client, username, password) => this.authenticate(client, username, password),
      onPublish: (client, topic, payload, retained) => this.onPublish(client, topic, payload, retained),
    });
    broker.on('client-connected', (client: Client) => {
      const st = this.pending.get(client);
      if (st) this.live.set(client, st);
    });
    broker.on('client-disconnected', (client: Client) => {
      const st = this.live.get(client);
      if (!st) return;
      this.live.delete(client);
      this.pushRecent({
        at: Date.now(),
        kind: 'disconnected',
        clientId: st.clientId,
        remoteAddress: st.remoteAddress,
        observerKey: st.observerKey,
        reason: st.lastRejectReason,
      });
    });
    broker.on('oversize-connection', () => {
      this.totals.rejected++;
      this.pushRecent({
        at: Date.now(),
        kind: 'disconnected',
        clientId: '',
        remoteAddress: null,
        observerKey: null,
        reason: 'payload_too_large',
      });
    });
    try {
      await broker.start();
    } catch (err) {
      this.lastBrokerError = err instanceof Error ? err.message : String(err);
      await broker.stop().catch(() => {});
      throw err;
    }
    this.broker = broker;
    this.lastBrokerError = null;

    if (cfg.targets.length > 0) {
      const firstRegion = cfg.regions.values().next();
      this.forwarder = new MeshCoreBrokerForwarder({
        sourceId: this.sourceId,
        targets: cfg.targets,
        ownIdentityName: cfg.ownIdentityName,
        fallbackRegion: firstRegion.done ? 'test' : firstRegion.value,
        loadOwnKey: async () => this.ownKey,
        onForwarded: (payload) => this.rememberForwarded(payload),
      });
      await this.forwarder.start();
    }
  }

  override async stop(): Promise<void> {
    await super.stop();
    const forwarder = this.forwarder;
    const broker = this.broker;
    this.forwarder = null;
    this.broker = null;
    if (forwarder) await forwarder.stop();
    if (broker) await broker.stop();
    this.live.clear();
  }

  override isConnected(): boolean {
    return this.broker?.getStatus().listening ?? false;
  }

  override getStatus(): MeshCoreMqttBrokerSourceStatus {
    return {
      sourceId: this.sourceId,
      sourceName: this.sourceName,
      sourceType: this.sourceType,
      connected: this.isConnected(),
      authStopped: false,
      permissionMessage: null,
      lastError: this.broker?.getStatus().lastError ?? this.lastBrokerError,
      clientCount: this.live.size,
    };
  }

  override getFeedEndpoint(): { region: string; brokerUrl: string } {
    const regions = [...this.brokerConfig.regions];
    const port = this.broker?.boundPort() ?? this.brokerConfig.port;
    return {
      region: regions.length > 0 ? regions.join(',') : '*',
      brokerUrl: `mqtt://${this.brokerConfig.host}:${port}`,
    };
  }

  /** Bound listener port (tests start on port 0). */
  getBoundPort(): number | null {
    return this.broker?.boundPort() ?? null;
  }

  getDiagnostics(): MeshCoreBrokerDiagnostics {
    const cfg = this.brokerConfig;
    const status = this.broker?.getStatus();
    return {
      listening: status?.listening ?? false,
      port: status?.port ?? null,
      clientCount: this.live.size,
      lastError: status?.lastError ?? this.lastBrokerError,
      limits: {
        maxClients: cfg.maxClients,
        maxMessagesPerSecond: cfg.maxMessagesPerSecond,
        maxPayloadBytes: cfg.maxPayloadBytes,
      },
      regions: [...cfg.regions],
      tokenAuth: cfg.tokenAudience !== null,
      staticAuth: cfg.staticUsername !== null && cfg.staticPassword !== null,
      allowedObserverCount: cfg.allowedObservers.size,
      ownIdentityPublicKey: this.ownKey?.publicKey ?? null,
      totals: { ...this.totals },
      connections: [...this.live.values()].map(
        ({ windowStart: _ws, windowCount: _wc, ...diag }) => ({ ...diag }),
      ),
      recent: [...this.recent].reverse(),
      forwarding: this.forwarder?.getStatus() ?? [],
    };
  }

  private async loadOwnKey(): Promise<OwnIdentityKey | null> {
    try {
      const r = await getMeshCoreObserverKeyStore().load(this.sourceId);
      if (r.kind !== 'ok') return null;
      const publicKey = (r.publicKeyHex ?? (await deriveObserverPublicKey(r.privateKeyHex))).toUpperCase();
      return { privateKeyHex: r.privateKeyHex, publicKey };
    } catch (err) {
      logger.debug(`[MeshCoreBroker:${this.sourceId}] could not load own observer key: ${(err as Error).message}`);
      return null;
    }
  }

  private pushRecent(event: BrokerRecentEvent): void {
    this.recent.push(event);
    if (this.recent.length > RECENT_MAX) this.recent.splice(0, this.recent.length - RECENT_MAX);
  }

  private refuse(
    client: Client,
    reason: BrokerRejectReason,
    observerKey: string | null,
    returnCode: 2 | 3 | 4 | 5,
  ): MeshCoreBrokerAuthDecision {
    this.totals.authRejected++;
    this.pushRecent({
      at: Date.now(),
      kind: 'auth_rejected',
      clientId: String(client.id ?? ''),
      remoteAddress: remoteAddressOf(client),
      observerKey,
      reason,
    });
    logger.debug(
      `[MeshCoreBroker:${this.sourceId}] refused login (${reason})` +
        (observerKey ? ` for observer ${observerKey.slice(0, 16)}…` : ''),
    );
    return { ok: false, returnCode };
  }

  private admit(client: Client, authMode: 'token' | 'static', observerKey: string | null): MeshCoreBrokerAuthDecision {
    this.pending.set(client, {
      clientId: String(client.id ?? ''),
      remoteAddress: remoteAddressOf(client),
      authMode,
      observerKey,
      connectedAt: Date.now(),
      received: 0,
      accepted: 0,
      rejected: 0,
      rateDropped: 0,
      lastTopic: null,
      lastMessageAt: null,
      lastRejectReason: null,
      lastRejectAt: null,
      windowStart: 0,
      windowCount: 0,
    });
    return { ok: true };
  }

  private async authenticate(
    client: Client,
    username: string,
    password: Buffer | undefined,
  ): Promise<MeshCoreBrokerAuthDecision> {
    const cfg = this.brokerConfig;
    const tokenMatch = TOKEN_USERNAME_RE.exec(username);
    const claimedKey = tokenMatch ? tokenMatch[1].toUpperCase() : null;

    if (this.live.size >= cfg.maxClients) return this.refuse(client, 'max_clients', claimedKey, 3);

    const secret = password ? password.toString('utf8') : '';

    // Static login: only when both halves are configured and the name matches.
    if (cfg.staticUsername !== null && cfg.staticPassword !== null && username === cfg.staticUsername) {
      return safeEqual(secret, cfg.staticPassword)
        ? this.admit(client, 'static', null)
        : this.refuse(client, 'auth_bad_credentials', null, 4);
    }

    // Token login: `v1_{PUBKEY}` + token. Anything else (incl. anonymous) is refused.
    if (!claimedKey || cfg.tokenAudience === null || secret === '') {
      return this.refuse(client, 'auth_bad_credentials', claimedKey, 4);
    }
    // Our own forwarding identity coming back in is a loop, never an observer.
    if (this.ownKey && claimedKey === this.ownKey.publicKey) {
      return this.refuse(client, 'auth_own_identity', claimedKey, 5);
    }
    if (!cfg.allowedObservers.has(claimedKey)) return this.refuse(client, 'auth_not_allowlisted', claimedKey, 5);

    let payload: Awaited<ReturnType<typeof verifyAuthToken>>;
    try {
      payload = await verifyAuthToken(secret, claimedKey);
    } catch {
      payload = null;
    }
    if (!payload || String(payload.publicKey ?? '').toUpperCase() !== claimedKey) {
      return this.refuse(client, 'auth_bad_token', claimedKey, 4);
    }
    if (payload.aud !== cfg.tokenAudience) return this.refuse(client, 'auth_bad_audience', claimedKey, 4);
    return this.admit(client, 'token', claimedKey);
  }

  private reject(st: ConnectionState, reason: BrokerRejectReason, isPacket: boolean): void {
    st.rejected++;
    st.lastRejectReason = reason;
    st.lastRejectAt = Date.now();
    this.totals.rejected++;
    if (isPacket) this.stats.rejected++;
  }

  private onPublish(client: Client, topic: string, payload: Buffer, retained: boolean): void {
    const st = this.live.get(client) ?? this.pending.get(client);
    if (!st) return;
    const now = Date.now();
    st.received++;
    st.lastTopic = topic;
    st.lastMessageAt = now;
    this.totals.received++;

    const parts = topic.split('/');
    const kind = parts.length === 4 && parts[0] === 'meshcore' ? parts[3] : null;
    const isPacket = kind === 'packets';
    if (isPacket) this.stats.received++;

    // Rate limit first: it is the cheapest check and the one that protects the rest.
    if (now - st.windowStart >= 1000) {
      st.windowStart = now;
      st.windowCount = 0;
    }
    st.windowCount++;
    if (st.windowCount > this.brokerConfig.maxMessagesPerSecond) {
      st.rateDropped++;
      this.totals.rateDropped++;
      this.reject(st, 'rate', isPacket);
      return;
    }

    if (payload.length > this.brokerConfig.maxPayloadBytes) return this.reject(st, 'payload_too_large', isPacket);
    if (kind !== 'packets' && kind !== 'status') return this.reject(st, 'bad_topic', false);

    const iata = parts[1];
    const topicKeyRaw = parts[2];
    if (!OBSERVER_KEY_RE.test(topicKeyRaw)) return this.reject(st, 'bad_topic', isPacket);
    const topicKey = topicKeyRaw.toUpperCase();
    if (!IATA_RE.test(iata)) return this.reject(st, 'bad_region', isPacket);
    if (this.brokerConfig.regions.size > 0 && !this.brokerConfig.regions.has(iata.toUpperCase())) {
      return this.reject(st, 'bad_region', isPacket);
    }
    // A token login publishes only under its own key (binding decision 3).
    if (st.authMode === 'token' && st.observerKey !== topicKey) return this.reject(st, 'key_mismatch', isPacket);
    if (st.authMode === 'static') {
      st.observerKey = topicKey;
      // The allowlist binds every login, not only token logins.
      if (!this.brokerConfig.allowedObservers.has(topicKey)) return this.reject(st, 'not_allowlisted', isPacket);
    }
    if (this.ownKey && topicKey === this.ownKey.publicKey) return this.reject(st, 'loop', isPacket);
    if (this.isRecentlyForwarded(payload)) return this.reject(st, 'loop', isPacket);

    let body: unknown;
    try {
      body = JSON.parse(payload.toString('utf8'));
    } catch {
      return this.reject(st, 'bad_json', isPacket);
    }

    if (isPacket) {
      const decoded = decodeObserverPacketMessageDetailed(body);
      if (!decoded.ok) return this.reject(st, decoded.reason, true);
      if (decoded.packet.originId !== topicKey) return this.reject(st, 'key_mismatch', true);
      st.accepted++;
      this.totals.accepted++;
      this.ingestDecodedPacket(decoded.packet);
    } else {
      const status = decodeObserverStatusMessage(body);
      if (!status) return this.reject(st, 'bad_status', false);
      if (status.originId !== topicKey) return this.reject(st, 'key_mismatch', false);
      st.accepted++;
      this.totals.accepted++;
      void this.ingestDecodedStatus(status);
    }

    this.forwarder?.forward({
      kind: isPacket ? 'packets' : 'status',
      topic,
      payload,
      retained,
      iata,
      observerKey: topicKey,
      body: body as Record<string, unknown>,
    });
  }

  private rememberForwarded(payload: Buffer): void {
    const now = Date.now();
    const digest = payloadDigest(payload);
    // Delete first: Map.set on an existing key keeps its old position, which
    // would break "insertion order is expiry order" for a re-forwarded payload.
    this.forwardedDigests.delete(digest);
    this.forwardedDigests.set(digest, now + LOOP_MEMORY_MS);
    // Insertion order is expiry order: trim expired (or over-cap) entries from
    // the front. The entry just added is last, so it is never trimmed here.
    for (const [key, expires] of this.forwardedDigests) {
      if (expires > now && this.forwardedDigests.size <= LOOP_MEMORY_MAX) break;
      this.forwardedDigests.delete(key);
    }
  }

  private isRecentlyForwarded(payload: Buffer): boolean {
    if (this.forwardedDigests.size === 0) return false;
    const expires = this.forwardedDigests.get(payloadDigest(payload));
    return expires !== undefined && expires > Date.now();
  }
}

function remoteAddressOf(client: Client): string | null {
  const conn = (client as unknown as { conn?: { remoteAddress?: unknown } }).conn;
  return typeof conn?.remoteAddress === 'string' ? conn.remoteAddress : null;
}
