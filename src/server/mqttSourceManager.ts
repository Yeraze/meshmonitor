import { EventEmitter } from 'events';
import type { Source } from '../db/repositories/sources.js';
import type { ISourceManager, SourceStatus } from './sourceManagerRegistry.js';
import { MqttBrokerClient, type MqttBrokerMessage } from './transports/mqttBrokerClient.js';
import { MqttPacketFilter, type MqttFilterConfig } from './mqttPacketFilter.js';
import meshtasticProtobufService from './meshtasticProtobufService.js';
import { PortNum } from './constants/meshtastic.js';
import databaseService from '../services/database.js';
import { logger } from '../utils/logger.js';

const ECHO_SUPPRESSION_WINDOW_MS = 60_000;
const MAX_ECHO_SUPPRESSION_SIZE = 256;

export interface MqttGatewayIdentity {
  nodeNum: number;
  nodeId: string;
  longName: string;
  shortName: string;
}

export interface MqttSourceConfig {
  broker: {
    url: string;
    username?: string;
    password?: string;
  };
  tls?: {
    rejectUnauthorized?: boolean;
    ca?: string;
    cert?: string;
    key?: string;
  };
  gateway: MqttGatewayIdentity;
  /** Root topic for outbound publishes (default 'msh') */
  rootTopic?: string;
  /** Topic subscription filters. Defaults to `${rootTopic}/2/e/#` if unset. */
  subscriptions?: string[];
  /** Outbound publish settings. */
  publish?: {
    enabled?: boolean;
    retain?: boolean;
  };
  filters?: MqttFilterConfig;
  autoConnect?: boolean;
}

export interface MqttSourceStatus extends SourceStatus {
  droppedPackets: number;
  filterDrops: ReturnType<MqttPacketFilter['getDropCounters']>;
  /** Last connect/subscribe error message, if any. Cleared on successful connect. */
  lastError?: string;
}

/**
 * MqttSourceManager — a first-class source whose transport is an MQTT broker.
 *
 * Two roles:
 *  1. **Independent ingestion** — subscribe to ServiceEnvelope topics, decode,
 *     filter, persist matched packets into nodes/messages/telemetry attributed
 *     to this source's `sourceId`.
 *  2. **Broker bridge for Quick Connect** — Meshtastic source managers linked
 *     to this MQTT source observe the `brokerMessage` event and call
 *     `publishRawProxyMessage()` to send firmware-originated proxy traffic
 *     to the upstream broker.
 */
export class MqttSourceManager extends EventEmitter implements ISourceManager {
  readonly sourceId: string;
  readonly sourceType = 'mqtt' as const;

  private readonly config: MqttSourceConfig;
  private readonly broker: MqttBrokerClient;
  private readonly filter: MqttPacketFilter;
  /** packetId → publishedAt(ms). Used to suppress broker echo of our own publishes. */
  private readonly recentlyPublishedIds = new Map<number, number>();

  private started = false;
  private droppedPackets = 0;
  private lastError: string | undefined = undefined;

  constructor(sourceId: string, config: MqttSourceConfig) {
    super();
    this.sourceId = sourceId;
    this.config = config;
    this.filter = new MqttPacketFilter(config.filters ?? {});
    this.broker = new MqttBrokerClient({
      brokerUrl: config.broker.url,
      username: config.broker.username,
      password: config.broker.password,
      clientIdPrefix: `mm-${sourceId.slice(0, 8)}`,
      tls: config.tls,
    });
  }

  async start(): Promise<void> {
    if (this.started) return;

    this.broker.on('connect', () => {
      this.lastError = undefined;
      this.emit('connect');
    });
    this.broker.on('offline', () => this.emit('offline'));
    this.broker.on('error', (err: Error) => {
      this.lastError = err.message;
      logger.warn(`[MQTT:${this.sourceId}] broker error: ${err.message}`);
    });
    this.broker.on('message', (msg) => this.handleBrokerMessage(msg));

    try {
      await this.broker.connect();
    } catch (err) {
      this.lastError = (err as Error).message;
      logger.error(`[MQTT:${this.sourceId}] connect failed:`, err);
      // Don't re-throw — the registry catches and silently drops the manager
      // from active state if start() rejects, which leaves no way for the
      // status endpoint to surface what went wrong. By swallowing here and
      // recording the error, the source stays registered, getStatus()
      // reports `connected: false` plus a `lastError`, and the UI can show
      // a meaningful message instead of just "Disconnected".
      this.started = true;
      return;
    }

    const subs = this.config.subscriptions && this.config.subscriptions.length > 0
      ? this.config.subscriptions
      : [`${this.config.rootTopic ?? 'msh'}/2/e/#`];
    try {
      await this.broker.subscribe(subs);
      logger.info(`[MQTT:${this.sourceId}] subscribed to: ${subs.join(', ')}`);
    } catch (err) {
      logger.warn(`[MQTT:${this.sourceId}] initial subscribe failed:`, err);
    }

    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    try {
      await this.broker.disconnect();
    } catch (err) {
      logger.warn(`[MQTT:${this.sourceId}] error during disconnect:`, err);
    }
    this.removeAllListeners();
  }

  getStatus(): MqttSourceStatus {
    return {
      sourceId: this.sourceId,
      sourceName: this.sourceId,
      sourceType: this.sourceType,
      connected: this.broker.connected,
      nodeNum: this.config.gateway.nodeNum,
      nodeId: this.config.gateway.nodeId,
      droppedPackets: this.droppedPackets,
      filterDrops: this.filter.getDropCounters(),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  getLocalNodeInfo() {
    const { gateway } = this.config;
    return {
      nodeNum: gateway.nodeNum,
      nodeId: gateway.nodeId,
      longName: gateway.longName,
      shortName: gateway.shortName,
      hwModel: 0,
    };
  }

  get rootTopic(): string {
    return this.config.rootTopic ?? 'msh';
  }

  /**
   * Relay raw firmware-originated `mqttClientProxyMessage` data to the broker.
   * Called by linked Meshtastic managers (Quick Connect). The payload is
   * opaque — never decode-then-re-encode (firmware may be sending encrypted
   * bytes for QoS reasons).
   */
  async publishRawProxyMessage(topic: string, data: Uint8Array, retained = false): Promise<void> {
    if (!this.broker.connected) {
      logger.warn(`[MQTT:${this.sourceId}] cannot publish — broker not connected`);
      return;
    }
    this.recordPublishForEchoSuppression(data);
    await this.broker.publish(topic, Buffer.from(data), { retain: retained });
  }

  /**
   * Publish a text message on a channel from our synthetic gateway identity.
   * Returns the MeshPacket id used (random uint32) so callers can correlate.
   */
  async publishTextMessage(channelName: string, text: string): Promise<number> {
    if (!this.broker.connected) {
      throw new Error('Broker not connected');
    }
    if (this.config.publish?.enabled === false) {
      throw new Error('Outbound publish is disabled on this MQTT source');
    }

    const payloadBytes = new TextEncoder().encode(text);
    const packetId = Math.floor(Math.random() * 0xffffffff) >>> 0;
    const meshPacket = {
      from: this.config.gateway.nodeNum,
      to: 0xffffffff,
      id: packetId,
      channel: 0,
      hopLimit: 3,
      decoded: {
        portnum: PortNum.TEXT_MESSAGE_APP,
        payload: payloadBytes,
      },
      rxTime: Math.floor(Date.now() / 1000),
    };
    const envelope = meshtasticProtobufService.encodeServiceEnvelope({
      packet: meshPacket,
      channelId: channelName,
      gatewayId: this.config.gateway.nodeId,
    });
    if (!envelope) throw new Error('Failed to encode ServiceEnvelope');

    const topic = `${this.rootTopic}/2/e/${encodeURIComponent(channelName)}/${this.config.gateway.nodeId}`;
    this.recordPublishForEchoSuppression(envelope);
    await this.broker.publish(topic, Buffer.from(envelope), {
      retain: this.config.publish?.retain ?? false,
    });
    return packetId;
  }

  /** For tests / introspection. */
  getDroppedPackets(): number {
    return this.droppedPackets;
  }

  private handleBrokerMessage(msg: MqttBrokerMessage): void {
    // Notify any observers first (Quick Connect relay) — proxy relay is
    // independent of ingestion filters.
    this.emit('brokerMessage', msg);

    // Ingestion path
    let envelope: ReturnType<typeof meshtasticProtobufService.decodeServiceEnvelope> = null;
    try {
      envelope = meshtasticProtobufService.decodeServiceEnvelope(
        msg.payload instanceof Uint8Array ? msg.payload : new Uint8Array(msg.payload),
      );
    } catch (err) {
      logger.debug(`[MQTT:${this.sourceId}] decodeServiceEnvelope threw:`, err);
    }

    // preFilter runs against topic + envelope metadata. With no envelope
    // (un-decodable bytes) we still let topic-only filters decide; passing
    // `null` returns no channelId/from/to/portnum, so allow-lists drop it.
    if (!this.filter.preFilter(msg.topic, envelope ?? undefined)) {
      this.droppedPackets++;
      return;
    }
    if (!envelope) return;

    const packetId = envelope.packet?.id !== undefined ? Number(envelope.packet.id) : 0;
    if (packetId && this.isEcho(packetId)) {
      return;
    }

    this.ingestPacket(envelope.packet, envelope).catch((err) =>
      logger.warn(`[MQTT:${this.sourceId}] ingest failed: ${(err as Error).message}`),
    );
  }

  private async ingestPacket(
    packet: any,
    envelope: { channelId?: string; gatewayId?: string },
  ): Promise<void> {
    if (!packet?.decoded) return; // encrypted / undecodable — skip for now
    const fromNum = Number(packet.from ?? 0);
    if (!fromNum) return;

    const fromNodeId = `!${(fromNum >>> 0).toString(16).padStart(8, '0')}`;
    const toNum = packet.to !== undefined ? Number(packet.to) : 0xffffffff;
    const toNodeId = `!${(toNum >>> 0).toString(16).padStart(8, '0')}`;
    const portnum = packet.decoded.portnum as number;
    const payload = packet.decoded.payload as Uint8Array | undefined;
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);

    let decoded: any = null;
    if (payload && payload.length > 0) {
      try {
        decoded = meshtasticProtobufService.processPayload(portnum, payload);
      } catch (err) {
        logger.debug(`[MQTT:${this.sourceId}] processPayload threw for portnum ${portnum}:`, err);
        return;
      }
    }

    switch (portnum) {
      case PortNum.NODEINFO_APP:
        if (!decoded) return;
        await databaseService.nodes.upsertNode(
          {
            nodeNum: fromNum,
            nodeId: fromNodeId,
            longName: decoded.longName ?? decoded.long_name ?? null,
            shortName: decoded.shortName ?? decoded.short_name ?? null,
            hwModel: decoded.hwModel ?? decoded.hw_model ?? null,
            lastHeard: nowSec,
            updatedAt: nowMs,
            viaMqtt: true,
          },
          this.sourceId,
        );
        break;

      case PortNum.POSITION_APP: {
        if (!decoded) return;
        if (!this.filter.postFilterPosition(decoded)) {
          this.droppedPackets++;
          return;
        }
        const latI = decoded.latitudeI ?? decoded.latitude_i;
        const lonI = decoded.longitudeI ?? decoded.longitude_i;
        if (typeof latI !== 'number' || typeof lonI !== 'number') return;
        await databaseService.nodes.upsertNode(
          {
            nodeNum: fromNum,
            nodeId: fromNodeId,
            latitude: latI / 1e7,
            longitude: lonI / 1e7,
            altitude: typeof decoded.altitude === 'number' ? decoded.altitude : null,
            positionTimestamp: typeof decoded.time === 'number' ? decoded.time : nowSec,
            lastHeard: nowSec,
            updatedAt: nowMs,
            viaMqtt: true,
          },
          this.sourceId,
        );
        break;
      }

      case PortNum.TELEMETRY_APP:
        if (!decoded) return;
        await this.ingestTelemetry(fromNum, fromNodeId, decoded, packet, nowMs);
        // Touch node lastHeard
        await databaseService.nodes.upsertNode(
          {
            nodeNum: fromNum,
            nodeId: fromNodeId,
            lastHeard: nowSec,
            updatedAt: nowMs,
            viaMqtt: true,
          },
          this.sourceId,
        );
        break;

      case PortNum.TEXT_MESSAGE_APP: {
        // decoded payload for TEXT_MESSAGE is the raw string
        const text = typeof decoded === 'string'
          ? decoded
          : (payload
            ? new TextDecoder('utf-8').decode(
              payload instanceof Uint8Array ? payload : new Uint8Array(payload),
            )
            : '');
        if (!text) return;
        const pktId = Number(packet.id ?? 0);
        const messageId = `${this.sourceId}_${fromNum}_${pktId || nowMs}`;
        await databaseService.messages.insertMessage(
          {
            id: messageId,
            fromNodeNum: fromNum,
            toNodeNum: toNum,
            fromNodeId,
            toNodeId,
            text,
            channel: Number(packet.channel ?? 0),
            portnum,
            timestamp: nowMs,
            rxTime: nowSec,
            hopStart: packet.hopStart !== undefined ? Number(packet.hopStart) : null,
            hopLimit: packet.hopLimit !== undefined ? Number(packet.hopLimit) : null,
            viaMqtt: true,
            createdAt: nowMs,
          } as any,
          this.sourceId,
        );
        // Touch node lastHeard
        await databaseService.nodes.upsertNode(
          {
            nodeNum: fromNum,
            nodeId: fromNodeId,
            lastHeard: nowSec,
            updatedAt: nowMs,
            viaMqtt: true,
          },
          this.sourceId,
        );
        // Persist channel name from envelope if we have one
        if (envelope.channelId) {
          // Future: ensure channel row exists; deferred to a follow-up
        }
        break;
      }

      default:
        // Other portnums (ROUTING, ADMIN, TRACEROUTE, etc.) intentionally
        // skipped for MQTT-origin packets — no peer state to act on.
        break;
    }
  }

  private async ingestTelemetry(
    fromNum: number,
    nodeId: string,
    telemetry: any,
    packet: any,
    nowMs: number,
  ): Promise<void> {
    const packetId = packet.id !== undefined ? Number(packet.id) : undefined;
    const packetTimestamp = typeof telemetry.time === 'number' ? telemetry.time * 1000 : undefined;
    const rows: { type: string; value: number; unit?: string }[] = [];

    if (telemetry.deviceMetrics) {
      const dm = telemetry.deviceMetrics;
      if (isFiniteNumber(dm.batteryLevel)) rows.push({ type: 'batteryLevel', value: dm.batteryLevel, unit: '%' });
      if (isFiniteNumber(dm.voltage)) rows.push({ type: 'voltage', value: dm.voltage, unit: 'V' });
      if (isFiniteNumber(dm.channelUtilization)) rows.push({ type: 'channelUtilization', value: dm.channelUtilization, unit: '%' });
      if (isFiniteNumber(dm.airUtilTx)) rows.push({ type: 'airUtilTx', value: dm.airUtilTx, unit: '%' });
      if (isFiniteNumber(dm.uptimeSeconds)) rows.push({ type: 'uptimeSeconds', value: dm.uptimeSeconds, unit: 's' });
    } else if (telemetry.environmentMetrics) {
      const env = telemetry.environmentMetrics;
      if (isFiniteNumber(env.temperature)) rows.push({ type: 'temperature', value: env.temperature, unit: '°C' });
      if (isFiniteNumber(env.relativeHumidity)) rows.push({ type: 'humidity', value: env.relativeHumidity, unit: '%' });
      if (isFiniteNumber(env.barometricPressure)) rows.push({ type: 'pressure', value: env.barometricPressure, unit: 'hPa' });
    }

    for (const r of rows) {
      await databaseService.telemetry.insertTelemetry(
        {
          nodeId,
          nodeNum: fromNum,
          telemetryType: r.type,
          timestamp: nowMs,
          value: r.value,
          unit: r.unit ?? null,
          createdAt: nowMs,
          packetTimestamp: packetTimestamp ?? null,
          packetId: packetId ?? null,
        } as any,
        this.sourceId,
      );
    }
  }

  private recordPublishForEchoSuppression(envelopeBytes: Uint8Array): void {
    try {
      const env = meshtasticProtobufService.decodeServiceEnvelope(envelopeBytes);
      const id = env?.packet?.id;
      if (id === undefined || id === null) return;
      const key = Number(id);
      if (!Number.isFinite(key) || key <= 0) return;
      const now = Date.now();
      this.recentlyPublishedIds.set(key, now);
      // Prune expired entries
      for (const [k, ts] of this.recentlyPublishedIds) {
        if (now - ts > ECHO_SUPPRESSION_WINDOW_MS) this.recentlyPublishedIds.delete(k);
      }
      // Cap size
      while (this.recentlyPublishedIds.size > MAX_ECHO_SUPPRESSION_SIZE) {
        const oldest = this.recentlyPublishedIds.keys().next().value;
        if (oldest === undefined) break;
        this.recentlyPublishedIds.delete(oldest);
      }
    } catch {
      // best-effort
    }
  }

  private isEcho(packetId: number): boolean {
    const ts = this.recentlyPublishedIds.get(packetId);
    if (ts === undefined) return false;
    if (Date.now() - ts > ECHO_SUPPRESSION_WINDOW_MS) {
      this.recentlyPublishedIds.delete(packetId);
      return false;
    }
    return true;
  }
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Read MqttSourceConfig out of a Source row, validating required fields. */
export function mqttSourceConfigFromSource(source: Source): MqttSourceConfig | null {
  const cfg = source.config as Partial<MqttSourceConfig> | undefined;
  if (!cfg || typeof cfg !== 'object') return null;
  if (!cfg.broker?.url) return null;
  const gw = cfg.gateway;
  if (!gw || typeof gw.nodeNum !== 'number' || !gw.nodeId || !gw.longName || !gw.shortName) {
    return null;
  }
  return cfg as MqttSourceConfig;
}
