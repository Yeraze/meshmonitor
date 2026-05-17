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
import { ingestServiceEnvelope } from './mqttIngestion.js';
import meshtasticProtobufService from './meshtasticProtobufService.js';
import type { ISourceManager, SourceStatus } from './sourceManagerRegistry.js';
import type { Source } from '../db/repositories/sources.js';
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

  constructor(sourceId: string, sourceName: string, config: MqttBrokerSourceConfig) {
    super();
    this.sourceId = sourceId;
    this.sourceName = sourceName;
    this.config = config;
    this.filter = new MqttPacketFilter({});
  }

  async start(): Promise<void> {
    if (this.broker) return;
    this.broker = new MqttBroker({
      port: this.config.listener.port,
      host: this.config.listener.host,
      auth: this.config.auth,
      brokerId: `meshmonitor-${this.sourceId}`,
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
  }

  async stop(): Promise<void> {
    if (!this.broker) return;
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

  /** Publish a raw payload to a topic on this broker. */
  async publish(topic: string, payload: Buffer, retained = false): Promise<void> {
    if (!this.broker) throw new Error('Broker not started');
    await this.broker.publish(topic, payload, retained);
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

    const result = ingestServiceEnvelope({
      sourceId: this.sourceId,
      envelope,
      filter: this.filter,
    });

    if (result.ingested) this.packetsIngested++;
    else this.packetsDropped++;

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
