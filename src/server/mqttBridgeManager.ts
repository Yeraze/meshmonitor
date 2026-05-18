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
 */

import { EventEmitter } from 'events';
import { MqttBrokerClient, type MqttClientCapabilities } from './transports/mqttBrokerClient.js';
import {
  MqttPacketFilter,
  type MqttFilterConfig,
  type ServiceEnvelopeShape,
  type PositionShape,
} from './mqttPacketFilter.js';
import { ingestServiceEnvelope } from './mqttIngestion.js';
import { PortNum } from './constants/meshtastic.js';
import meshtasticProtobufService from './meshtasticProtobufService.js';
import type { ISourceManager, SourceStatus } from './sourceManagerRegistry.js';
import { sourceManagerRegistry } from './sourceManagerRegistry.js';
import type { MqttBrokerManager, MqttBrokerLocalPacket } from './mqttBrokerManager.js';
import type { Source } from '../db/repositories/sources.js';
import { logger } from '../utils/logger.js';

export interface MqttBridgeSourceConfig {
  brokerSourceId: string;
  upstream: {
    url: string;
    username?: string;
    password?: string;
  };
  subscriptions: string[];
  downlinkFilters?: MqttFilterConfig;
  uplinkFilters?: MqttFilterConfig;
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
}

interface EchoEntry { topic: string; packetId: number; expiresAt: number }

const ECHO_TTL_MS = 60_000;
const ECHO_MAX = 256;

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
  private lastError: string | null = null;
  private readonly downlinkEchoes: EchoEntry[] = [];
  private readonly uplinkEchoes: EchoEntry[] = [];

  constructor(sourceId: string, sourceName: string, config: MqttBridgeSourceConfig) {
    super();
    this.sourceId = sourceId;
    this.sourceName = sourceName;
    this.config = config;
    this.downlinkFilter = new MqttPacketFilter(config.downlinkFilters);
    this.uplinkFilter = new MqttPacketFilter(config.uplinkFilters);
  }

  async start(): Promise<void> {
    this.attachParentBroker();

    this.client = new MqttBrokerClient({
      url: this.config.upstream.url,
      username: this.config.upstream.username,
      password: this.config.upstream.password,
      clientIdPrefix: `mm-bridge-${this.sourceId}`,
    });
    this.client.on('error', (err) => {
      this.lastError = err.message;
    });
    this.client.on('permission-denied', (info: { kind: 'auth' | 'subscribe'; message: string }) => {
      // Mirror to lastError so legacy UI tooltips (which only show on
      // disconnect) still pick it up. The dedicated permissionMessage
      // surface is preferred for connected-but-restricted bridges.
      this.lastError = info.message;
      logger.warn(
        `MQTT bridge ${this.sourceId} permission issue (${info.kind}): ${info.message}`,
      );
      this.emit('permission-denied', info);
    });
    this.client.on('message', (msg) => this.handleDownlink(msg.topic, msg.payload, msg.retained));

    await this.client.connect();
    if (this.config.subscriptions.length > 0) {
      await this.client.subscribe(this.config.subscriptions);
    }
    logger.info(
      `MQTT bridge ${this.sourceId} subscribed to ${this.config.subscriptions.length} upstream topic(s)`,
    );
  }

  async stop(): Promise<void> {
    this.detachParentBroker();
    if (this.client) {
      await this.client.disconnect();
      this.client = null;
    }
  }

  getStatus(): MqttBridgeStatus {
    const capabilities: MqttClientCapabilities = this.client
      ? this.client.getCapabilities()
      : { canSubscribe: true, canPublish: 'unknown', authFailed: false, deniedSubscriptions: [] };
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
      lastError: this.lastError ?? this.client?.getLastError() ?? null,
      capabilities,
      permissionMessage: buildPermissionMessage(capabilities, this.config.subscriptions.length),
    };
  }

  getLocalNodeInfo() {
    return null;
  }

  private attachParentBroker(): void {
    const existing = sourceManagerRegistry.getManager(this.config.brokerSourceId);
    if (existing && existing.sourceType === 'mqtt_broker') {
      this.parentBroker = existing as MqttBrokerManager;
      this.bindParentListener();
      return;
    }

    // Defer until the broker is registered. Listen for manager-started.
    this.registryAddedListener = (m: ISourceManager) => {
      if (m.sourceId === this.config.brokerSourceId && m.sourceType === 'mqtt_broker') {
        this.parentBroker = m as MqttBrokerManager;
        this.bindParentListener();
        logger.info(
          `MQTT bridge ${this.sourceId} attached to deferred parent broker ${m.sourceId}`,
        );
      }
    };
    sourceManagerRegistry.on('manager-started', this.registryAddedListener);

    this.registryRemovedListener = (m: ISourceManager) => {
      if (m.sourceId === this.config.brokerSourceId) {
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

    // Apply geo filter early — position packets outside the bbox must
    // not be republished to the local broker, otherwise they'd pollute
    // the nodeDBs of devices connected to it. Passing `from` to
    // postFilterPosition lets the filter cache this node's membership
    // so non-position packets can be gated by `passesMembership` below.
    const fromNum = typeof envelope.packet?.from === 'number' ? envelope.packet.from >>> 0 : null;
    if (envelope.packet?.decoded?.portnum === PortNum.POSITION_APP) {
      const position = decodePosition(envelope.packet.decoded.payload);
      if (!this.downlinkFilter.postFilterPosition(position, fromNum ?? undefined)) return;
    } else {
      // Fail-closed: drop non-position traffic from senders we haven't
      // already classified as inside the bbox. Encrypted packets (no
      // decoded portnum) also flow through here — `decoded` would be
      // undefined, the strict equality above is false, and we end up
      // gated on membership too. That's intentional: an encrypted
      // packet from an unknown sender should also be dropped.
      if (!this.downlinkFilter.passesMembership(fromNum)) return;
    }

    const result = ingestServiceEnvelope({
      sourceId: this.sourceId,
      envelope,
      filter: this.downlinkFilter,
    });
    if (result.ingested) this.downlinkIngested++;

    // Republish to local broker so devices see it. Skip if no parent attached.
    if (this.parentBroker) {
      this.parentBroker
        .publish(topic, payload, retained)
        .then(() => {
          this.downlinkRepublished++;
          this.recordEcho(this.downlinkEchoes, topic, packetId);
        })
        .catch((err) => {
          this.lastError = `local republish failed: ${err.message}`;
        });
    }
  }

  private handleUplink(p: MqttBrokerLocalPacket): void {
    if (!this.client || !this.client.isConnected()) return;

    const packetId = p.envelope.packet?.id !== undefined ? (p.envelope.packet.id >>> 0) : null;
    if (packetId !== null && this.matchesEcho(this.downlinkEchoes, p.topic, packetId)) {
      return;
    }

    if (!this.uplinkFilter.preFilter(p.topic, p.envelope)) return;

    this.client
      .publish(p.topic, p.payload, p.retained)
      .then(() => {
        this.uplinkOut++;
        this.recordEcho(this.uplinkEchoes, p.topic, packetId);
      })
      .catch((err) => {
        this.lastError = `upstream publish failed: ${err.message}`;
      });
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
