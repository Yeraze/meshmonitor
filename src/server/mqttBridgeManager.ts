/**
 * MQTT bridge source manager.
 *
 * Bridges one upstream MQTT broker to a local MqttBrokerManager source,
 * with independent downlink and uplink filter rules.
 *
 * - Downlink (upstream → local): subscribe to upstream topics, apply
 *   `downlinkFilters`, decode and persist matching ServiceEnvelopes with
 *   this bridge's `sourceId`, and republish raw bytes to the local
 *   broker so devices connected locally see the same wire format.
 * - Uplink (local → upstream): listen to the parent broker's
 *   `local-packet` event, apply `uplinkFilters`, and publish raw bytes
 *   to the upstream broker.
 *
 * Echo suppression: each direction records (topic, packetId) of recently
 * forwarded messages; matching inbound packets are dropped to prevent
 * round-trip loops.
 *
 * Standalone mode (issue #3134): when `brokerSourceId` is omitted, the
 * bridge runs without a parent broker — downlink still ingests upstream
 * traffic (no local republish), and the bridge can act as a client-proxy
 * target for a meshtastic_tcp source via `publish()` + `local-packet`
 * events, the same shape exposed by MqttBrokerManager.
 */

import { EventEmitter } from 'events';
import { MqttBrokerClient, MqttReconnectCoordinator, type MqttClientCapabilities } from './transports/mqttBrokerClient.js';
import {
  MqttPacketFilter,
  type MqttFilterConfig,
  type ServiceEnvelopeShape,
  type PositionShape,
} from './mqttPacketFilter.js';
import { ingestServiceEnvelope, bootstrapMqttChannelDatabase } from './mqttIngestion.js';
import { PortNum } from './constants/meshtastic.js';
import meshtasticProtobufService from './meshtasticProtobufService.js';
import type { ISourceManager, SourceStatus } from './sourceManagerRegistry.js';
import { sourceManagerRegistry } from './sourceManagerRegistry.js';
import type { MqttBrokerManager, MqttBrokerLocalPacket } from './mqttBrokerManager.js';
import type { Source } from '../db/repositories/sources.js';
import databaseService from '../services/database.js';
import { logger } from '../utils/logger.js';
import { loadAllNodesAsDeviceInfo } from './utils/dbNodeMapper.js';
import type { DeviceInfo } from './meshtasticManager.js';
import {
  MqttBridgePublisherPool,
  formatGatewayClientId,
  type PoolPublishResult,
  type PublisherStatus,
} from './mqttBridgePublisherPool.js';
import { allowsUplink, resolveOkToMqttForEnvelope } from './utils/okToMqtt.js';
import { automationPacketTracker } from './utils/automationPacketTracker.js';
import { DistanceDeleteScheduler } from './services/distanceDeleteScheduler.js';
import { mqttGeoSweepService, type GeoSweepStats } from './services/mqttGeoSweepService.js';

/**
 * Direction the bridge is permitted to operate in against the upstream
 * broker. Defaults to `bidirectional` for back-compat with rows saved
 * before this field existed.
 *
 * - `bidirectional`: subscribe to upstream topics AND forward local
 *   traffic upstream. Original behavior.
 * - `publish_only`: skip the upstream `subscribe()` call entirely. Use
 *   this for public servers (e.g. mqtt.meshtastic.org) that allow
 *   PUBLISH from gateways but deny SUBSCRIBE — without this, the bridge
 *   spams permission-denied warnings on every SUBACK.
 * - `subscribe_only`: skip uplink forwarding (don't bind the parent
 *   broker's `local-packet` listener and reject calls to `publish()`).
 *   Use this for read-only monitoring.
 */
export type MqttBridgeMode = 'bidirectional' | 'publish_only' | 'subscribe_only';

/**
 * Per-bridge upstream forwarding identity model.
 *
 * - `per_gateway` (default): each `local-packet`'s `gateway_id` is
 *   dispatched through its own upstream MQTT connection with
 *   `clientId = '!' + hex8(gatewayNum)`. The parent broker's own
 *   gateway nodeId doubles as the subscriber connection so MQTT 3.1.1
 *   §3.1.4's mandatory-disconnect rule for duplicate Client IDs cannot
 *   trip. Required for upstream brokers that filter CONNECT on Client
 *   ID (e.g. community brokers that whitelist `!<8-hex>`).
 * - `single`: legacy behavior — one upstream connection with
 *   `mm-bridge-<sourceId>-<random>` Client ID handles every uplink.
 *   Useful for upstream brokers with tight per-username connection caps.
 */
export type MqttBridgeForwardingMode = 'per_gateway' | 'single';

export interface MqttBridgeSourceConfig {
  /**
   * Optional parent mqtt_broker source. When set, downlink packets are
   * republished to that broker (so locally-connected devices see them)
   * and `local-packet` events from the broker drive uplink forwarding.
   * When unset, the bridge runs as a pure upstream MQTT client — useful
   * for monitoring a remote broker, or for acting as a `mqttLink`
   * client-proxy target for a meshtastic_tcp source (issue #3134).
   */
  brokerSourceId?: string;
  upstream: {
    url: string;
    username?: string;
    password?: string;
  };
  subscriptions: string[];
  /** See {@link MqttBridgeMode}. Defaults to `'bidirectional'` when unset. */
  mode?: MqttBridgeMode;
  downlinkFilters?: MqttFilterConfig;
  uplinkFilters?: MqttFilterConfig;
  /**
   * Literal prefix replacement applied to the topic immediately before
   * republish to the parent broker (downlink) or publish upstream
   * (uplink). Useful for bridging between meshes that use different MQTT
   * root topics (e.g. msh/US/TX ↔ msh/US/LA — issue #3166).
   *
   * Semantics: filters run on the ORIGINAL (received) topic, rewrites
   * apply only at publish time, and the echo cache is keyed on the
   * post-rewrite topic so feedback loops are still suppressed.
   *
   * MQTT wildcards (+, #) are NOT supported — `from` must be a literal
   * prefix (the validator on sourceRoutes rejects wildcards). Trailing
   * slashes on `from`/`to` are normalized away.
   */
  downlinkTopicRewrite?: TopicRewriteRule;
  uplinkTopicRewrite?: TopicRewriteRule;
  /**
   * See {@link MqttBridgeForwardingMode}. Defaults to `per_gateway` when
   * unset. Only meaningful when the bridge has a `brokerSourceId`
   * (standalone bridges have no `local-packet` stream to dispatch over).
   */
  forwardingMode?: MqttBridgeForwardingMode;
  /**
   * When true, uplink every packet regardless of the originator's
   * `ok_to_mqtt` preference (bit 0 of `Data.bitfield`, set firmware-side
   * via `Config.LoRaConfig.config_ok_to_mqtt`). Default false — the bridge
   * mirrors firmware MQTT::onSend behavior and drops packets whose
   * originator opted out of MQTT relay.
   *
   * Setting this to true is a knowledgeable-operator override. It violates
   * the originating node's stated preference and can republish private
   * mesh traffic to a public broker. Only use on private/known-restricted
   * upstreams where the operator has explicit consent from every gateway.
   */
  ignoreOkToMqtt?: boolean;
  /**
   * When true, do not uplink packets MeshMonitor's own automations sent
   * (auto-ack, auto-responder, auto-announce, timers, geofences, Automation
   * Engine actions, ...) — #5414. Manual sends still follow the normal rules.
   * Default false (unchanged behaviour on upgrade).
   *
   * Only covers this bridge's uplink. A device whose built-in MQTT module
   * publishes straight to the upstream broker bypasses it. Firmware will not
   * add a per-packet override (declined in meshtastic/firmware#11994).
   */
  dropAutomationUplinks?: boolean;
}

/**
 * Rejected logins in a row before one of a bridge's upstream clients stops
 * reconnecting. Counted per client: the subscriber and each per-gateway
 * publisher have their own count, and a successful connect resets it.
 * Same number the MeshCore ingest source uses (#5596).
 */
export const BRIDGE_MAX_AUTH_FAILURES = 5;

/**
 * What the bridge status says once the broker has rejected the subscriber's
 * login {@link BRIDGE_MAX_AUTH_FAILURES} times.
 *
 * A fixed string on purpose: `/api/sources/:id/status` is readable without a
 * login, so nothing from the config (username, password, broker host) and
 * nothing from the broker's own error text may ride along.
 */
export const BRIDGE_AUTH_STOPPED_MESSAGE =
  `Broker rejected the login ${BRIDGE_MAX_AUTH_FAILURES} times in a row, so this bridge stopped ` +
  'reconnecting. Fix the username or password and save the source, or reconnect it.';

/** Literal prefix replacement rule applied to a Meshtastic MQTT topic. */
export interface TopicRewriteRule {
  from: string;
  to: string;
}

/**
 * Apply a literal prefix-replacement rule to a topic.
 *
 * - Returns the topic unchanged when the rule is null/undefined, when
 *   `from` or `to` are empty after trimming trailing slashes, or when
 *   `from` doesn't match the topic's prefix.
 * - Trailing slashes on `from` and `to` are normalized away so
 *   `{from: "msh/US/TX/", to: "msh/US/LA"}` works the same as
 *   `{from: "msh/US/TX", to: "msh/US/LA/"}`.
 * - Replaces the literal prefix `from` (and the segment separator `/`
 *   that follows it) with `to`, preserving the rest of the topic
 *   unchanged. An exact match (topic equals `from`) returns `to`.
 *
 * Exported for unit testing.
 */
export function applyTopicRewrite(
  topic: string,
  rule: TopicRewriteRule | null | undefined,
): string {
  if (!rule) return topic;
  const from = stripTrailingSlashes(rule.from);
  const to = stripTrailingSlashes(rule.to);
  if (!from || !to || from === to) return topic;
  if (topic === from) return to;
  if (topic.startsWith(from + '/')) return to + topic.slice(from.length);
  return topic;
}

// Linear-time trailing-slash strip. Replaces `.replace(/\/+$/, '')` which
// CodeQL flags as polynomial-ReDoS on user-controlled input (js/polynomial-redos).
function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 0x2f) end--;
  return end === s.length ? s : s.slice(0, end);
}

export interface MqttBridgeStatus extends SourceStatus {
  upstreamConnected: boolean;
  parentBrokerAttached: boolean;
  downlinkIn: number;
  downlinkIngested: number;
  downlinkRepublished: number;
  uplinkOut: number;
  downlinkDrops: ReturnType<MqttPacketFilter['getDropCounters']>;
  uplinkDrops: ReturnType<MqttPacketFilter['getDropCounters']>;
  /**
   * Count of uplink packets dropped because the originator's `ok_to_mqtt`
   * preference forbade republish (or the packet was encrypted and we
   * couldn't decrypt it to read the bit). Sits outside `uplinkDrops`
   * because the gate isn't part of MqttPacketFilter — it's a bridge-level
   * policy mirroring firmware MQTT::onSend.
   */
  uplinkOkToMqttDrops: number;
  /**
   * Count of uplink packets dropped because MeshMonitor's own automation sent
   * them and `dropAutomationUplinks` is on (#5414).
   */
  uplinkAutomationDrops: number;
  /**
   * True once the SUBSCRIBER client gave up after
   * {@link BRIDGE_MAX_AUTH_FAILURES} rejected logins in a row. Intake is
   * halted; per-gateway publishers that still log in keep working. A config
   * save or a manual connect clears it.
   */
  authStopped: boolean;
  /**
   * `!<8-hex>` ids of the per-gateway publishers that gave up the same way.
   * Node ids: the status route removes this list for callers without
   * `nodes:read` and leaves them {@link authStoppedGatewayCount}.
   */
  authStoppedGateways: string[];
  authStoppedGatewayCount: number;
  /**
   * Uplink packets thrown away because the client that would carry them was
   * stopped. Dropped, never queued and never replayed.
   */
  uplinkAuthStoppedDrops: number;
  lastError: string | null;
  /**
   * Inferred broker ACL state. `permissionMessage` is non-null when the
   * broker has restricted what this bridge can do (subscribe-only,
   * publish-only, auth-rejected) — surface it to the user so they know
   * why some traffic isn't flowing. See MqttClientCapabilities for the
   * caveats on `canPublish` at QoS 0.
   */
  capabilities: MqttClientCapabilities;
  permissionMessage: string | null;
  /** Resolved bridge mode (defaults to `bidirectional`). */
  mode: MqttBridgeMode;
  /** Resolved forwarding mode (defaults to `per_gateway`). */
  forwardingMode: MqttBridgeForwardingMode;
  /**
   * Per-gateway publisher status when `forwardingMode === 'per_gateway'`.
   * Keyed by `!<8-hex>` Client ID. Empty when the bridge is in `single`
   * mode or when no `local-packet` traffic has been seen yet.
   */
  publishers: Record<string, PublisherStatus>;
  /**
   * Stats from the most recent MQTT Geo-Ignore retroactive sweep (Phase 3),
   * or `null` before the first sweep completes. See `mqttGeoSweepService`.
   */
  lastGeoSweep: GeoSweepStats | null;
}

interface EchoEntry { topic: string; packetId: number; expiresAt: number }

const ECHO_TTL_MS = 60_000;
const ECHO_MAX = 256;

/**
 * Parse a Meshtastic ServiceEnvelope `gateway_id` string (`!<8-hex>`) into
 * the unsigned 32-bit nodeNum. Returns null for unparseable input so the
 * caller can fall back to the subscriber connection — we never want a
 * malformed envelope to take down the uplink path.
 */
export function extractGatewayNum(gatewayId: string | undefined): number | null {
  if (typeof gatewayId !== 'string') return null;
  const hex = gatewayId.startsWith('!') ? gatewayId.slice(1) : gatewayId;
  if (!/^[0-9a-fA-F]{1,8}$/.test(hex)) return null;
  const n = parseInt(hex, 16);
  return Number.isFinite(n) ? n >>> 0 : null;
}

export class MqttBridgeManager extends EventEmitter implements ISourceManager {
  readonly sourceId: string;
  readonly sourceType: Source['type'] = 'mqtt_bridge';
  private readonly sourceName: string;
  private readonly config: MqttBridgeSourceConfig;
  private client: MqttBrokerClient | null = null;
  private parentBroker: MqttBrokerManager | null = null;
  private parentListener: ((p: MqttBrokerLocalPacket) => void) | null = null;
  private registryAddedListener: ((m: ISourceManager) => void) | null = null;
  private registryRemovedListener: ((m: ISourceManager) => void) | null = null;
  private readonly downlinkFilter: MqttPacketFilter;
  private readonly uplinkFilter: MqttPacketFilter;
  private downlinkIn = 0;
  private downlinkIngested = 0;
  private downlinkRepublished = 0;
  private uplinkOut = 0;
  private uplinkOkToMqttDrops = 0;
  private uplinkAutomationDrops = 0;
  private lastError: string | null = null;
  private readonly downlinkEchoes: EchoEntry[] = [];
  private readonly uplinkEchoes: EchoEntry[] = [];
  /**
   * Per-gateway publisher pool. Non-null only while the bridge is
   * running in `per_gateway` mode with a parent broker attached.
   * Holds one MQTT connection per `gateway_id` seen in `local-packet`.
   */
  private publisherPool: MqttBridgePublisherPool | null = null;
  private reconnectCoordinator: MqttReconnectCoordinator | null = null;
  /**
   * In `per_gateway` mode, the gatewayNum whose pool entry doubles as
   * the subscriber connection (i.e., the parent broker's own gateway
   * nodeId). When `gateway_id` of an uplink packet matches this, the
   * publish rides `this.client` instead of being dispatched into a
   * separate pool entry — see MQTT 3.1.1 §3.1.4 duplicate-clientId rule.
   */
  private brokerGatewayNum: number | null = null;
  private readonly distanceDeleteScheduler: DistanceDeleteScheduler;
  /** Stats from the most recent geo sweep (MQTT Geo-Ignore epic, Phase 3). */
  private lastGeoSweep: GeoSweepStats | null = null;
  /** Client ID the subscriber logs in with; undefined = random `mm-bridge-…`. */
  private subscriberClientId: string | undefined;
  /**
   * True once the broker rejected the subscriber's login
   * {@link BRIDGE_MAX_AUTH_FAILURES} times in a row and it gave up.
   *
   * In memory only, by design: a process restart is five fresh attempts, then
   * the stop applies again. Stopping sends nothing, so there is no timer for a
   * save to re-arm; a config save builds a new manager (five fresh attempts),
   * and `reconnectAuthStopped()` rebuilds only the stopped clients. Persisting
   * the stop would leave a bridge dead after the operator fixed the broker.
   */
  private subscriberAuthStopped = false;
  /** Uplink packets dropped on the stopped subscriber client. */
  private subscriberAuthStoppedDrops = 0;

  constructor(sourceId: string, sourceName: string, config: MqttBridgeSourceConfig) {
    super();
    this.sourceId = sourceId;
    this.sourceName = sourceName;
    this.config = config;
    this.downlinkFilter = new MqttPacketFilter(config.downlinkFilters);
    this.uplinkFilter = new MqttPacketFilter(config.uplinkFilters);
    this.distanceDeleteScheduler = new DistanceDeleteScheduler(sourceId);
  }

  /** Start this source's per-source auto-delete-by-distance scheduler (#3901). */
  async startDistanceDeleteScheduler(): Promise<void> {
    await this.distanceDeleteScheduler.start();
  }

  /** Stop this source's per-source auto-delete-by-distance scheduler (#3901). */
  stopDistanceDeleteScheduler(): void {
    this.distanceDeleteScheduler.stop();
  }

  /**
   * Sink for `mqttGeoSweepService.runSweep` (MQTT Geo-Ignore epic, Phase 3).
   * Satisfies `GeoSweepStatsSink` via duck typing.
   */
  recordGeoSweepStats(stats: GeoSweepStats): void {
    this.lastGeoSweep = stats;
  }

  /** Resolves the configured forwarding mode, defaulting to `'per_gateway'`. */
  private getForwardingMode(): MqttBridgeForwardingMode {
    return this.config.forwardingMode ?? 'per_gateway';
  }

  async start(): Promise<void> {
    this.attachParentBroker();
    await bootstrapMqttChannelDatabase(this.sourceId);

    // Per-source auto-delete-by-distance (#3901). Started up front so the
    // publish_only early-return below doesn't skip it. Background concern —
    // a settings-read hiccup must not stop the bridge from coming up.
    this.distanceDeleteScheduler.start().catch((err) =>
      logger.error(`Failed to start distance-delete scheduler for source ${this.sourceId}:`, err));

    // Retroactive geo sweep (MQTT Geo-Ignore epic, Phase 3). Add-only
    // (`lift: false`): a plain restart has no previous bbox to diff against,
    // so lifting on every boot would permanently readmit nodes that were
    // silently purged under a still-current bbox. Lifting only happens on
    // the config-save path, which knows the bbox actually changed. Fire-
    // and-forget — a background concern that must not delay bridge startup.
    mqttGeoSweepService
      .runSweep(this.sourceId, this.config.downlinkFilters?.geo, { lift: false, sink: this })
      .catch(err => logger.error(`Geo sweep failed for source ${this.sourceId}:`, err));

    const mode = this.getMode();
    const forwardingMode = this.getForwardingMode();

    // In per_gateway mode with a parent broker attached, the bridge's
    // subscriber connection takes the broker's gateway nodeId as its
    // Client ID — so the upstream broker sees the bridge as the broker
    // node, not as an opaque `mm-bridge-…`. The same connection is also
    // the publisher for traffic whose gateway_id IS the broker's nodeId
    // (avoids the MQTT 3.1.1 §3.1.4 duplicate-clientId disconnect).
    this.reconnectCoordinator = new MqttReconnectCoordinator();

    let subscriberClientId: string | undefined;
    if (forwardingMode === 'per_gateway' && this.parentBroker) {
      const localInfo = this.parentBroker.getLocalNodeInfo();
      this.brokerGatewayNum = localInfo.nodeNum >>> 0;
      subscriberClientId = formatGatewayClientId(this.brokerGatewayNum);
      this.publisherPool = new MqttBridgePublisherPool({
        url: this.config.upstream.url,
        username: this.config.upstream.username,
        password: this.config.upstream.password,
        poolLabel: this.sourceId,
        reconnectCoordinator: this.reconnectCoordinator,
        maxAuthFailures: BRIDGE_MAX_AUTH_FAILURES,
      });
    }

    this.subscriberClientId = subscriberClientId;
    this.subscriberAuthStopped = false;
    await this.connectSubscriber();
    if (mode === 'publish_only') {
      logger.info(
        `MQTT bridge ${this.sourceId} started in publish_only mode — skipping upstream subscribe`,
      );
      return;
    }
    logger.info(
      `MQTT bridge ${this.sourceId} subscribed to ${this.config.subscriptions.length} upstream topic(s) (mode=${mode}, forwarding=${forwardingMode})`,
    );
  }

  /**
   * Build the subscriber client, log in, and subscribe. Used by `start()` and
   * by `reconnectAuthStopped()`; each call is a new client, so a new count of
   * rejected logins.
   */
  private async connectSubscriber(): Promise<void> {
    const mode = this.getMode();
    const subscriberClientId = this.subscriberClientId;
    const client = new MqttBrokerClient({
      url: this.config.upstream.url,
      username: this.config.upstream.username,
      password: this.config.upstream.password,
      // Explicit clientId in per_gateway mode (broker's gateway nodeId);
      // fall back to the legacy `mm-bridge-…` prefix in single mode or
      // when no parent broker is attached (standalone bridge).
      clientId: subscriberClientId,
      clientIdPrefix: subscriberClientId ? undefined : `mm-bridge-${this.sourceId}`,
      // A rejected login does not fix itself; without this a wrong password
      // costs the broker a CONNECT every ~60 s for ever.
      maxAuthFailures: BRIDGE_MAX_AUTH_FAILURES,
    });
    this.client = client;
    if (this.reconnectCoordinator) client.setCoordinator(this.reconnectCoordinator);
    client.on('error', (err) => {
      this.lastError = err.message;
    });
    client.on('permission-denied', (info: { kind: 'auth' | 'subscribe'; message: string }) => {
      // In publish_only mode the operator has explicitly opted out of
      // subscribing, so suppress SUBACK-denied noise — only surface auth
      // failures, which are still actionable.
      if (mode === 'publish_only' && info.kind === 'subscribe') return;
      // Mirror to lastError so legacy UI tooltips (which only show on
      // disconnect) still pick it up. The dedicated permissionMessage
      // surface is preferred for connected-but-restricted bridges.
      this.lastError = info.message;
      logger.warn(
        `MQTT bridge ${this.sourceId} permission issue (${info.kind}): ${info.message}`,
      );
      this.emit('permission-denied', info);
    });
    client.on('message', (msg) => this.handleDownlink(msg.topic, msg.payload, msg.retained));
    client.on('auth-stopped', () => this.onSubscriberAuthStopped(client));

    await client.connect();
    // stop() or an auth stop may have run while the login was in flight.
    if (this.client !== client || this.subscriberAuthStopped) return;
    if (mode !== 'publish_only' && this.config.subscriptions.length > 0) {
      await client.subscribe(this.config.subscriptions);
    }
  }

  /**
   * The broker rejected the subscriber's login too many times: give up until
   * someone acts.
   *
   * The client has already stopped scheduling retries. Here we record why and
   * close the socket. Intake halts; per-gateway publishers are separate
   * clients with their own counts and keep going. `this.client` stays set (a
   * closed, never-connected object) so the pool path in `handleUplink` still
   * runs.
   */
  private onSubscriberAuthStopped(client: MqttBrokerClient): void {
    if (this.client !== client) return; // A stale client from before a restart.
    this.subscriberAuthStopped = true;
    this.lastError = BRIDGE_AUTH_STOPPED_MESSAGE;
    logger.warn(
      `MQTT bridge ${this.sourceId}: broker rejected the subscriber login ${BRIDGE_MAX_AUTH_FAILURES} times in a row; ` +
        'stopped reconnecting until the source is saved or reconnected',
    );
    // Listeners stay attached until the socket is closed: the client still
    // emits 'error' for this same rejection, and an EventEmitter with no
    // 'error' listener throws.
    void client.disconnect().catch((err) => {
      logger.debug(`MQTT bridge ${this.sourceId}: error closing rejected client:`, err);
    });
  }

  /**
   * Manual reconnect: give every client that stopped after rejected logins a
   * fresh start, and leave the rest alone. A healthy or still-retrying client
   * is never touched, so a repeated click cannot churn a working session or
   * add login attempts.
   *
   * Sends nothing to the mesh and replays nothing: packets dropped while a
   * client was stopped are gone.
   */
  async reconnectAuthStopped(): Promise<{ subscriber: boolean; gateways: number }> {
    const gateways = this.publisherPool?.restartAuthStopped() ?? 0;
    let subscriber = false;
    if (this.subscriberAuthStopped && this.client) {
      const old = this.client;
      subscriber = true;
      this.subscriberAuthStopped = false;
      this.subscriberAuthStoppedDrops = 0;
      this.lastError = null;
      old.removeAllListeners();
      old.on('error', () => {});
      await old.disconnect().catch(() => {});
      await this.connectSubscriber();
    }
    return { subscriber, gateways };
  }

  /** True when the subscriber or any gateway publisher stopped after rejected logins. */
  hasAuthStop(): boolean {
    return this.subscriberAuthStopped || (this.publisherPool?.getAuthStoppedGateways().length ?? 0) > 0;
  }

  /** Resolves the configured mode, defaulting to `'bidirectional'`. */
  private getMode(): MqttBridgeMode {
    return this.config.mode ?? 'bidirectional';
  }

  async stop(): Promise<void> {
    this.distanceDeleteScheduler.stop();
    this.detachParentBroker();
    if (this.publisherPool) {
      await this.publisherPool.close();
      this.publisherPool = null;
    }
    if (this.client) {
      await this.client.disconnect();
      this.client = null;
    }
    if (this.reconnectCoordinator) {
      this.reconnectCoordinator.dispose();
      this.reconnectCoordinator = null;
    }
    this.brokerGatewayNum = null;
    // Stopped by hand is not "stopped by the broker"; start() begins clean.
    this.subscriberAuthStopped = false;
  }

  getStatus(): MqttBridgeStatus {
    const capabilities: MqttClientCapabilities = this.client
      ? this.client.getCapabilities()
      : { canSubscribe: true, canPublish: 'unknown', authFailed: false, deniedSubscriptions: [] };
    const mode = this.getMode();
    // publish_only never attempts to subscribe, so requestedSubscriptionCount
    // is effectively zero — passing 0 keeps buildPermissionMessage from
    // reporting "0 subscriptions denied" when there's no real failure.
    const requestedSubs = mode === 'publish_only' ? 0 : this.config.subscriptions.length;
    const stoppedGateways = this.publisherPool?.getAuthStoppedGateways() ?? [];
    // Fixed text only for a stop — this status is served to callers with no
    // login, so it never carries the broker's own words, host, or credentials.
    // Stopped gateways are reported by count and id below; the sidebar words
    // that itself, so `permissionMessage` only speaks for the subscriber.
    const stoppedMessage = this.subscriberAuthStopped ? BRIDGE_AUTH_STOPPED_MESSAGE : null;
    return {
      sourceId: this.sourceId,
      sourceName: this.sourceName,
      sourceType: this.sourceType,
      connected: this.client?.isConnected() ?? false,
      upstreamConnected: this.client?.isConnected() ?? false,
      parentBrokerAttached: this.parentBroker !== null,
      downlinkIn: this.downlinkIn,
      downlinkIngested: this.downlinkIngested,
      downlinkRepublished: this.downlinkRepublished,
      uplinkOut: this.uplinkOut,
      downlinkDrops: this.downlinkFilter.getDropCounters(),
      uplinkDrops: this.uplinkFilter.getDropCounters(),
      authStopped: this.subscriberAuthStopped,
      authStoppedGateways: stoppedGateways,
      authStoppedGatewayCount: stoppedGateways.length,
      uplinkAuthStoppedDrops:
        this.subscriberAuthStoppedDrops + (this.publisherPool?.getAuthStoppedDrops() ?? 0),
      lastError: this.subscriberAuthStopped
        ? BRIDGE_AUTH_STOPPED_MESSAGE
        : this.lastError ?? this.client?.getLastError() ?? null,
      capabilities,
      permissionMessage: stoppedMessage ?? buildPermissionMessage(capabilities, requestedSubs),
      mode,
      forwardingMode: this.getForwardingMode(),
      publishers: this.publisherPool?.getStatus() ?? {},
      uplinkOkToMqttDrops: this.uplinkOkToMqttDrops,
      uplinkAutomationDrops: this.uplinkAutomationDrops,
      lastGeoSweep: this.lastGeoSweep,
    };
  }

  /**
   * Determine whether the originator's `ok_to_mqtt` preference allows
   * this packet to be republished upstream. Mirrors firmware
   * `MQTT::onSend` (MQTT.cpp:767-788) — checks bit 0 of `Data.bitfield`.
   *
   * Delegates to the shared tri-state evaluator in `./utils/okToMqtt.js`
   * (#4114) — `resolveOkToMqttForEnvelope` reproduces this method's
   * original control flow exactly (decoded bitfield, else server-side
   * decrypt via the channel DB, else unknown), and `allowsUplink` applies
   * the fail-closed uplink policy: only an explicit `'yes'` allows
   * republishing. An `'unknown'` result (bit unreadable, decrypt failed,
   * or no matching channel key) → drop. This matches firmware's
   * fail-closed behavior on public brokers.
   *
   * Note: we deliberately do NOT special-case "private" upstream brokers
   * (per design — operator picks the override per-bridge via
   * `ignoreOkToMqtt` instead of relying on hostname heuristics).
   */
  private async evaluateOkToMqtt(envelope: ServiceEnvelopeShape): Promise<boolean> {
    return allowsUplink(await resolveOkToMqttForEnvelope(envelope));
  }

  getLocalNodeInfo() {
    return null;
  }

  /**
   * Meshtastic-shaped connection status, used by /api/poll and /api/connection
   * when those endpoints are scoped to this source. A bridge has no local
   * device so `nodeResponsive` is forced true (so the dashboard doesn't fall
   * into the "node-offline" UX) and `configuring` is always false.
   */
  async getConnectionStatus(): Promise<{
    connected: boolean;
    nodeResponsive: boolean;
    configuring: boolean;
    nodeIp: string;
    userDisconnected?: boolean;
  }> {
    const connected = this.client?.isConnected() ?? false;
    return {
      connected,
      nodeResponsive: connected,
      configuring: false,
      nodeIp: '',
      userDisconnected: false,
    };
  }

  /**
   * DB-backed node list, scoped to this bridge's source. Mirrors
   * MeshtasticManager.getAllNodesAsync so the consolidated /api/poll endpoint
   * doesn't have to special-case the manager type.
   */
  async getAllNodesAsync(sourceId?: string): Promise<DeviceInfo[]> {
    return loadAllNodesAsDeviceInfo(sourceId);
  }

  /**
   * Bridges have no local device, so there is no LoRa config to query. Used
   * by /api/device/tx-status — return a permissive default so the UI doesn't
   * gate features on a config that will never arrive.
   */
  async getDeviceConfig(): Promise<any> {
    return null;
  }

  /**
   * Bridges do not have device-resident node DBs. The Meshtastic concept of
   * "is this node in the radio's NodeDB" doesn't apply here, so report empty.
   */
  getDeviceNodeNums(): number[] {
    return [];
  }

  /**
   * Bridges have no PKI keypair of their own.
   */
  getSecurityKeys(): { publicKey: string | null; privateKey: string | null } {
    return { publicKey: null, privateKey: null };
  }

  /**
   * Publish a raw payload to the upstream broker through this bridge's
   * client connection. Used by the client-proxy mqttLink path so a
   * meshtastic_tcp source can route its device's MQTT traffic through a
   * standalone bridge (issue #3134). Mirrors MqttBrokerManager.publish so
   * a `mqttLink` target can be either type.
   */
  async publish(topic: string, payload: Buffer, retained = false): Promise<void> {
    if (this.getMode() === 'subscribe_only') {
      throw new Error(`MQTT bridge ${this.sourceId} is subscribe_only — publish refused`);
    }
    if (this.subscriberAuthStopped) {
      // Stopped after rejected logins: drop and count. No throw, so the caller
      // has nothing to log per packet and nothing to retry.
      this.noteSubscriberDrop();
      return;
    }
    if (!this.client || !this.client.isConnected()) {
      throw new Error(`MQTT bridge ${this.sourceId} not connected to upstream`);
    }
    await this.client.publish(topic, payload, retained);
  }

  /** Count an uplink packet dropped on the stopped subscriber; log the first. */
  private noteSubscriberDrop(): void {
    this.subscriberAuthStoppedDrops++;
    if (this.subscriberAuthStoppedDrops === 1) {
      logger.warn(
        `MQTT bridge ${this.sourceId}: subscriber is stopped after rejected logins; ` +
          'dropping the uplink packets it would carry until the source is saved or reconnected',
      );
    }
  }

  private attachParentBroker(): void {
    // Standalone mode (no parent broker configured) — nothing to attach.
    const brokerId = this.config.brokerSourceId;
    if (!brokerId) return;

    const existing = sourceManagerRegistry.getManager(brokerId);
    if (existing && existing.sourceType === 'mqtt_broker') {
      this.parentBroker = existing as MqttBrokerManager;
      this.bindParentListener();
      return;
    }

    // Defer until the broker is registered. Listen for manager-started.
    this.registryAddedListener = (m: ISourceManager) => {
      if (m.sourceId === brokerId && m.sourceType === 'mqtt_broker') {
        this.parentBroker = m as MqttBrokerManager;
        this.bindParentListener();
        logger.info(
          `MQTT bridge ${this.sourceId} attached to deferred parent broker ${m.sourceId}`,
        );
      }
    };
    sourceManagerRegistry.on('manager-started', this.registryAddedListener);

    this.registryRemovedListener = (m: ISourceManager) => {
      if (m.sourceId === brokerId) {
        this.unbindParentListener();
        this.parentBroker = null;
        logger.warn(
          `MQTT bridge ${this.sourceId} detached from parent broker (removed)`,
        );
      }
    };
    sourceManagerRegistry.on('manager-stopped', this.registryRemovedListener);
  }

  private detachParentBroker(): void {
    this.unbindParentListener();
    if (this.registryAddedListener) {
      sourceManagerRegistry.off('manager-started', this.registryAddedListener);
      this.registryAddedListener = null;
    }
    if (this.registryRemovedListener) {
      sourceManagerRegistry.off('manager-stopped', this.registryRemovedListener);
      this.registryRemovedListener = null;
    }
    this.parentBroker = null;
  }

  private bindParentListener(): void {
    if (!this.parentBroker || this.parentListener) return;
    // subscribe_only mode forwards nothing upstream — don't subscribe to the
    // parent broker's local-packet stream at all so we can't even race on it.
    if (this.getMode() === 'subscribe_only') return;
    this.parentListener = (p) => this.handleUplink(p);
    this.parentBroker.on('local-packet', this.parentListener);
  }

  private unbindParentListener(): void {
    if (this.parentBroker && this.parentListener) {
      this.parentBroker.off('local-packet', this.parentListener);
    }
    this.parentListener = null;
  }

  private handleDownlink(topic: string, payload: Buffer, retained: boolean): void {
    this.downlinkIn++;

    // Single decode pass — broad-topic subscriptions also see non-Meshtastic
    // payloads (firmware JSON output, broker heartbeats), so silence parse
    // failures rather than logging each one.
    const decoded = meshtasticProtobufService.decodeServiceEnvelope(payload, { quiet: true });
    if (!decoded) return;
    const envelope = decoded as ServiceEnvelopeShape;
    const packetId =
      typeof envelope.packet?.id === 'number' ? envelope.packet.id >>> 0 : null;

    // If we just sent this upstream, ignore the echo coming back down.
    if (packetId !== null && this.matchesEcho(this.uplinkEchoes, topic, packetId)) {
      return;
    }

    if (!this.downlinkFilter.preFilter(topic, envelope)) return;

    const fromNum = typeof envelope.packet?.from === 'number' ? envelope.packet.from >>> 0 : null;
    const decodedPortnum = envelope.packet?.decoded?.portnum;
    const hasDecoded = envelope.packet?.decoded != null && typeof decodedPortnum === 'number';
    const isPosition = decodedPortnum === PortNum.POSITION_APP;
    const isIgnored = fromNum !== null &&
      databaseService.ignoredNodes.isIgnoredCached(fromNum, this.sourceId);

    // Early-drop provably-non-position decoded traffic from ignored senders.
    // Encrypted packets (no decoded portnum) can't be proven non-position, so
    // they flow to ingestion, which re-drops non-position payloads from ignored
    // senders after decrypt. POSITION always flows so post-decrypt evaluation
    // can lift/re-ignore (reappearance path).
    if (isIgnored && hasDecoded && !isPosition) return;

    // Republish decision: never republish an ignored sender's traffic; never
    // republish an out-of-bbox plaintext position (pollutes local nodeDBs).
    // postFilterPosition increments drops.geo on the out case — run it for
    // every plaintext position (even already-ignored senders) so the counter
    // reflects all out-of-bbox position arrivals.
    // TODO(Phase 4): drops.geo only sees plaintext positions here; encrypted
    // out-of-bbox positions are classified post-decrypt in ingestion and are
    // not counted until per-reason counters land.
    //
    // Known one-packet window: `isIgnored` is the cached state at pre-gate
    // time, and ingestion (which inserts/lifts the geo-ignore) runs
    // fire-and-forget below. A node's very first out-of-bbox POSITION is
    // therefore emitted/republished once before the ignore takes effect;
    // every subsequent packet sees the updated cache. Accepted trade-off of
    // not blocking the packet loop on ingestion.
    let republishAllowed = !isIgnored;
    if (isPosition) {
      const position = decodePosition(envelope.packet!.decoded!.payload);
      const inside = this.downlinkFilter.postFilterPosition(position);
      if (!inside) republishAllowed = false;
    }

    ingestServiceEnvelope({
      sourceId: this.sourceId,
      envelope,
      filter: this.downlinkFilter,
      topic,
      // Self-echo guard (#4114, §2(f.1)): `null` before the broker reports
      // local node info / after a disconnect — the guard then simply does
      // not apply. Belt-and-braces on top of the (non-airtight) echo
      // suppression above (`matchesEcho`).
      localGatewayNodeNum: this.brokerGatewayNum,
    })
      .then((result) => {
        if (result.ingested) this.downlinkIngested++;
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`MQTT bridge ${this.sourceId} ingest failed: ${msg}`);
      });

    // Emit local-packet so consumers (e.g. a meshtastic_tcp source using
    // this bridge as its `mqttLink` client-proxy target — issue #3134) can
    // relay the upstream packet to their device. Shape matches
    // MqttBrokerLocalPacket so listeners can target either source type.
    // Gated on !isIgnored — an ignored sender's traffic must not reach
    // client-proxy devices either.
    if (!isIgnored) {
      this.emit('local-packet', {
        topic,
        payload,
        retained,
        envelope,
        clientId: null,
      });
    }

    // Republish to local broker so devices see it. Skip if no parent attached
    // or if this packet failed the ignore/geo republish gate above.
    if (this.parentBroker && republishAllowed) {
      // Apply downlink topic rewrite (#3166) right at the publish boundary —
      // ingestion, filters, and the local-packet event all stay on the
      // original topic. Echo recorded under the post-rewrite topic so the
      // uplink direction sees the same topic the parent broker emits.
      const publishTopic = applyTopicRewrite(topic, this.config.downlinkTopicRewrite);
      this.parentBroker
        .publish(publishTopic, payload, retained)
        .then(() => {
          this.downlinkRepublished++;
          this.recordEcho(this.downlinkEchoes, publishTopic, packetId);
        })
        .catch((err) => {
          this.lastError = `local republish failed: ${err.message}`;
        });
    }
  }

  private async handleUplink(p: MqttBrokerLocalPacket): Promise<void> {
    if (!this.client) return;

    const packetId = p.envelope.packet?.id !== undefined ? (p.envelope.packet.id >>> 0) : null;
    if (packetId !== null && this.matchesEcho(this.downlinkEchoes, p.topic, packetId)) {
      return;
    }

    if (!this.uplinkFilter.preFilter(p.topic, p.envelope)) return;

    // Drop packets MeshMonitor's own automations sent (#5414). The firmware
    // sets ok_to_mqtt on every phone-API packet from the node config, by
    // design (declined in meshtastic/firmware#11994), so this is the only
    // place we can keep automation traffic off the upstream broker. Matched on
    // (from, id): the tracker only knows packets our connected nodes
    // originated, so another node's packet never matches. Checked before ok_to_mqtt — it is a cheap
    // synchronous lookup and saves a decrypt.
    if (this.config.dropAutomationUplinks && packetId !== null) {
      // Coerce like the packet id above: some decode paths hand back a Long.
      const rawFrom = p.envelope.packet?.from;
      const from = rawFrom === undefined || rawFrom === null ? null : Number(rawFrom) >>> 0;
      if (automationPacketTracker.isAutomationPacket(from, packetId)) {
        this.uplinkAutomationDrops++;
        return;
      }
    }

    // Honor the originator's `ok_to_mqtt` preference unless the operator
    // has explicitly opted out for this bridge. See evaluateOkToMqtt for
    // the policy details — bridge-level gate, not part of the filter chain.
    if (!this.config.ignoreOkToMqtt) {
      const allow = await this.evaluateOkToMqtt(p.envelope);
      if (!allow) {
        this.uplinkOkToMqttDrops++;
        return;
      }
    }

    // Re-check after the await above: evaluateOkToMqtt can await a real
    // decrypt call, and `stop()` may run concurrently (bridge removed or
    // reconfigured mid-flight — #4400 investigation). If it did, `this.client`
    // is now null; dereferencing it below threw an unhandled rejection that,
    // via the global process safety net (processSafetyNet.ts), crashed the
    // whole server. Drop cleanly instead — the bridge is gone, there is
    // nothing to publish to.
    if (!this.client) return;

    // Apply uplink topic rewrite (#3166) — uplinkFilter ran on the original
    // topic; only the wire-level publish gets the rewrite. Echo recorded
    // under the post-rewrite topic so the downlink direction can suppress
    // the upstream broker's re-emission of this same packet.
    const publishTopic = applyTopicRewrite(p.topic, this.config.uplinkTopicRewrite);
    // Per-gateway dispatch: when the pool is active and the envelope's
    // gateway_id parses to a nodeNum different from the broker's own
    // gateway nodeId, publish through the pool entry whose clientId is
    // `!<gatewayHex>`. Otherwise (single mode, no pool, broker-self-
    // originated packet, or unparseable gateway_id) ride the subscriber
    // connection — which in per_gateway mode already uses the broker's
    // own nodeId as its Client ID.
    const gatewayNum = this.publisherPool ? extractGatewayNum(p.envelope.gatewayId) : null;
    const dispatchToPool =
      this.publisherPool !== null &&
      gatewayNum !== null &&
      gatewayNum !== this.brokerGatewayNum;

    const onSuccess = (result: PoolPublishResult | void) => {
      // A stopped gateway dropped the packet (the pool counted it). Nothing
      // went upstream, so there is nothing to count or to echo-suppress.
      if (result === 'dropped') return;
      this.uplinkOut++;
      this.recordEcho(this.uplinkEchoes, publishTopic, packetId);
    };
    const onError = (err: Error) => {
      this.lastError = `upstream publish failed: ${err.message}`;
    };

    if (dispatchToPool && this.publisherPool && gatewayNum !== null) {
      this.publisherPool
        .publish(gatewayNum, publishTopic, p.payload, p.retained)
        .then(onSuccess)
        .catch(onError);
    } else {
      if (this.subscriberAuthStopped) {
        this.noteSubscriberDrop();
        return;
      }
      if (!this.client.isConnected()) return;
      this.client
        .publish(publishTopic, p.payload, p.retained)
        .then(onSuccess)
        .catch(onError);
    }
  }

  private recordEcho(store: EchoEntry[], topic: string, packetId: number | null): void {
    if (packetId === null) return;
    const now = Date.now();
    // Drop expired.
    while (store.length > 0 && store[0].expiresAt < now) store.shift();
    if (store.length >= ECHO_MAX) store.shift();
    store.push({ topic, packetId, expiresAt: now + ECHO_TTL_MS });
  }

  private matchesEcho(store: EchoEntry[], topic: string, packetId: number): boolean {
    const now = Date.now();
    while (store.length > 0 && store[0].expiresAt < now) store.shift();
    return store.some((e) => e.topic === topic && e.packetId === packetId);
  }
}

/**
 * Build a user-facing summary of what the broker won't let us do.
 * Returns null when the broker appears fully permissive (or when we have no
 * evidence either way yet — e.g. before the first SUBACK lands).
 *
 * The message is intentionally one short sentence so it fits in a card
 * tooltip; the full per-topic denial list lives in `capabilities`.
 */
export function buildPermissionMessage(
  caps: MqttClientCapabilities,
  requestedSubscriptionCount: number,
): string | null {
  if (caps.authFailed) {
    return 'Broker rejected authentication — check credentials.';
  }
  const deniedCount = caps.deniedSubscriptions.length;
  if (deniedCount === 0) return null;
  // All subscriptions denied: this is effectively a publish-only endpoint
  // from our perspective. Downlink is dead until ACLs change.
  if (requestedSubscriptionCount > 0 && deniedCount >= requestedSubscriptionCount) {
    return `Broker denied all ${deniedCount} subscription(s). This endpoint appears to be publish-only — downlink is disabled.`;
  }
  const preview = caps.deniedSubscriptions.slice(0, 3).join(', ');
  const overflow = deniedCount > 3 ? ` (+${deniedCount - 3} more)` : '';
  return `Broker denied ${deniedCount} subscription(s): ${preview}${overflow}. Downlink reduced.`;
}

function decodePosition(payload: Uint8Array | undefined): PositionShape | null {
  if (!payload) return null;
  try {
    return meshtasticProtobufService.processPayload(PortNum.POSITION_APP, payload) as PositionShape;
  } catch {
    return null;
  }
}
