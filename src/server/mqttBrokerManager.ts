/**
 * MQTT broker source manager.
 *
 * Hosts an embedded MQTT broker (Aedes) on a configured TCP port. Local
 * Meshtastic devices connect and publish ServiceEnvelope-wrapped
 * MeshPackets; this manager decodes them and persists nodes / messages /
 * positions / telemetry under its own `sourceId`.
 *
 * Emits a `local-packet` event so MqttBridgeManager instances can pick
 * up locally-originated traffic and forward it upstream.
 */

import { EventEmitter } from 'events';
import { MqttBroker, type MqttBrokerPublish } from './transports/mqttBroker.js';
import { MqttPacketFilter, type ServiceEnvelopeShape } from './mqttPacketFilter.js';
import { ingestServiceEnvelope, bootstrapMqttChannelDatabase } from './mqttIngestion.js';
import meshtasticProtobufService from './meshtasticProtobufService.js';
import type { ISourceManager, SourceStatus } from './sourceManagerRegistry.js';
import type { Source } from '../db/repositories/sources.js';
import { loadAllNodesAsDeviceInfo } from './utils/dbNodeMapper.js';
import type { DeviceInfo } from './meshtasticManager.js';
import { DistanceDeleteScheduler } from './services/distanceDeleteScheduler.js';
import { logger } from '../utils/logger.js';

export interface MqttBrokerSourceConfig {
  listener: { port: number; host?: string };
  auth: { username: string; password: string };
  gateway: {
    nodeNum: number;
    nodeId: string;
    longName: string;
    shortName: string;
  };
  rootTopic?: string;
  /**
   * When true, clamp `hop_limit` to 0 on Meshtastic ServiceEnvelopes the
   * broker forwards back to its connected MQTT clients (issue #3084).
   * Mirrors how Meshtastic's public broker behaves — devices receiving an
   * MQTT-bridged packet won't re-flood it over RF. The transform runs on
   * delivery to each subscriber; the original payload still drives our
   * ingestion and uplink-bridge paths, so persisted hop diagnostics and
   * upstream re-publishes stay accurate. Defaults to false to preserve
   * the existing pass-through behavior for private-broker setups.
   */
  zeroHopInjection?: boolean;
}

export interface MqttBrokerStatus extends SourceStatus {
  listening: boolean;
  clientCount: number;
  packetsIn: number;
  packetsIngested: number;
  packetsDropped: number;
  lastError: string | null;
}

export interface MqttBrokerLocalPacket {
  topic: string;
  payload: Buffer;
  retained: boolean;
  envelope: ServiceEnvelopeShape;
  clientId: string | null;
}

/**
 * Events emitted on the MqttBrokerManager EventEmitter:
 * - 'local-packet' (p: MqttBrokerLocalPacket)
 * - 'client-connected' (clientId: string)
 * - 'client-disconnected' (clientId: string)
 */
export class MqttBrokerManager extends EventEmitter implements ISourceManager {
  readonly sourceId: string;
  readonly sourceType: Source['type'] = 'mqtt_broker';
  private readonly sourceName: string;
  private readonly config: MqttBrokerSourceConfig;
  private broker: MqttBroker | null = null;
  private packetsIn = 0;
  private packetsIngested = 0;
  private packetsDropped = 0;
  private readonly filter: MqttPacketFilter;
  private readonly distanceDeleteScheduler: DistanceDeleteScheduler;

  constructor(sourceId: string, sourceName: string, config: MqttBrokerSourceConfig) {
    super();
    this.sourceId = sourceId;
    this.sourceName = sourceName;
    this.config = config;
    this.filter = new MqttPacketFilter({});
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

  async start(): Promise<void> {
    if (this.broker) return;
    await bootstrapMqttChannelDatabase(this.sourceId);
    const rootTopicPrefix = (this.config.rootTopic ?? 'msh') + '/';
    this.broker = new MqttBroker({
      port: this.config.listener.port,
      host: this.config.listener.host,
      auth: this.config.auth,
      brokerId: `meshmonitor-${this.sourceId}`,
      forwardTransform: this.config.zeroHopInjection
        ? (topic, payload) => this.applyZeroHop(rootTopicPrefix, topic, payload)
        : undefined,
    });

    this.broker.on('publish', (msg) => this.handlePublish(msg));
    this.broker.on('client-connected', (id) => this.emit('client-connected', id));
    this.broker.on('client-disconnected', (id) => this.emit('client-disconnected', id));
    this.broker.on('error', (err) => {
      logger.error(`MqttBrokerManager ${this.sourceId} error: ${err.message}`);
    });

    await this.broker.start();
    logger.info(
      `MQTT broker source ${this.sourceId} listening on ${this.config.listener.host ?? '0.0.0.0'}:${this.config.listener.port}`,
    );

    // Per-source auto-delete-by-distance (#3901) — scoped to this broker's
    // own nodes/settings, not the old global all-sources singleton. Background
    // concern: a settings-read hiccup must not stop the broker from listening.
    this.distanceDeleteScheduler.start().catch((err) =>
      logger.error(`Failed to start distance-delete scheduler for source ${this.sourceId}:`, err));
  }

  async stop(): Promise<void> {
    if (!this.broker) return;
    this.distanceDeleteScheduler.stop();
    await this.broker.stop();
    this.broker = null;
  }

  getStatus(): MqttBrokerStatus {
    const s = this.broker?.getStatus();
    return {
      sourceId: this.sourceId,
      sourceName: this.sourceName,
      sourceType: this.sourceType,
      connected: s?.listening ?? false,
      nodeNum: this.config.gateway.nodeNum,
      nodeId: this.config.gateway.nodeId,
      listening: s?.listening ?? false,
      clientCount: s?.clientCount ?? 0,
      packetsIn: this.packetsIn,
      packetsIngested: this.packetsIngested,
      packetsDropped: this.packetsDropped,
      lastError: s?.lastError ?? null,
    };
  }

  getLocalNodeInfo() {
    return {
      nodeNum: this.config.gateway.nodeNum,
      nodeId: this.config.gateway.nodeId,
      longName: this.config.gateway.longName,
      shortName: this.config.gateway.shortName,
    };
  }

  /**
   * Meshtastic-shaped connection status, used by /api/poll and /api/connection
   * when scoped to this source. The embedded broker is the "device" here, so
   * `connected` tracks the listener and `nodeResponsive` follows it (the
   * dashboard shouldn't fall into the "node-offline" UX while the broker is up).
   * Mirrors MqttBridgeManager.getConnectionStatus.
   */
  async getConnectionStatus(): Promise<{
    connected: boolean;
    nodeResponsive: boolean;
    configuring: boolean;
    nodeIp: string;
    userDisconnected?: boolean;
  }> {
    const connected = this.broker?.getStatus()?.listening ?? false;
    return {
      connected,
      nodeResponsive: connected,
      configuring: false,
      nodeIp: '',
      userDisconnected: false,
    };
  }

  /**
   * DB-backed node list, scoped to this broker's source. Mirrors
   * MeshtasticManager/MqttBridgeManager.getAllNodesAsync so the consolidated
   * /api/poll endpoint doesn't have to special-case the manager type.
   * (Without this, /api/poll threw `getAllNodesAsync is not a function` and
   * 500'd for broker sources, so the dashboard/map showed no nodes — #issue.)
   */
  async getAllNodesAsync(sourceId?: string): Promise<DeviceInfo[]> {
    return loadAllNodesAsDeviceInfo(sourceId);
  }

  /**
   * The embedded broker has no local LoRa device, so there is no device config
   * to query. Used by /api/device/tx-status — return null like the bridge so
   * the UI doesn't gate features on a config that will never arrive.
   */
  async getDeviceConfig(): Promise<any> {
    return null;
  }

  /**
   * No device-resident NodeDB for a broker source.
   */
  getDeviceNodeNums(): number[] {
    return [];
  }

  /**
   * Broker sources have no PKI keypair of their own.
   */
  getSecurityKeys(): { publicKey: string | null; privateKey: string | null } {
    return { publicKey: null, privateKey: null };
  }

  /** Publish a raw payload to a topic on this broker. */
  async publish(topic: string, payload: Buffer, retained = false): Promise<void> {
    if (!this.broker) throw new Error('Broker not started');
    await this.broker.publish(topic, payload, retained);
  }

  /**
   * Zero-hop forward transform. Returns a rewritten payload with
   * `hop_limit = 0` for Meshtastic ServiceEnvelopes on this broker's
   * root topic, or null to pass the original through. Anything that
   * isn't a decodable ServiceEnvelope (off-topic, MQTT control, malformed
   * payload, packet already at zero) falls through unchanged.
   */
  private applyZeroHop(rootTopicPrefix: string, topic: string, payload: Buffer): Buffer | null {
    if (!topic.startsWith(rootTopicPrefix)) return null;
    const decoded = meshtasticProtobufService.decodeServiceEnvelope(payload, { quiet: true });
    if (!decoded || !decoded.packet) return null;
    const packet = decoded.packet as { hopLimit?: number; hopStart?: number };
    if (packet.hopLimit === undefined || packet.hopLimit === 0) return null;
    packet.hopLimit = 0;
    const reencoded = meshtasticProtobufService.encodeServiceEnvelope({
      packet: decoded.packet,
      channelId: decoded.channelId,
      gatewayId: decoded.gatewayId,
    });
    if (!reencoded) return null;
    return Buffer.from(reencoded);
  }

  private handlePublish(msg: MqttBrokerPublish): void {
    this.packetsIn++;

    // Skip MQTT control / system topics — only handle Meshtastic ServiceEnvelopes.
    if (msg.topic.startsWith('$SYS/') || !msg.topic.startsWith((this.config.rootTopic ?? 'msh') + '/')) {
      this.packetsDropped++;
      return;
    }

    const decoded = meshtasticProtobufService.decodeServiceEnvelope(msg.payload);
    if (!decoded) {
      this.packetsDropped++;
      return;
    }
    const envelope: ServiceEnvelopeShape = decoded as ServiceEnvelopeShape;

    ingestServiceEnvelope({
      sourceId: this.sourceId,
      envelope,
      filter: this.filter,
    })
      .then((result) => {
        if (result.ingested) this.packetsIngested++;
        else this.packetsDropped++;
      })
      .catch((err) => {
        this.packetsDropped++;
        const m = err instanceof Error ? err.message : String(err);
        logger.warn(`MQTT broker ${this.sourceId} ingest failed: ${m}`);
      });

    // Always emit, even if not ingested — bridges may want encrypted or
    // unsupported-portnum packets for uplink. They apply their own filter.
    this.emit('local-packet', {
      topic: msg.topic,
      payload: msg.payload,
      retained: msg.retained,
      envelope,
      clientId: msg.clientId,
    });
  }
}
