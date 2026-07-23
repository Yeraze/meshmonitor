import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { PortNum } from '../constants/meshtastic.js';
import meshtasticProtobufService from '../meshtasticProtobufService.js';
import { nodeNumToId, type ServiceEnvelopeShape } from '../mqttPacketFilter.js';
import type { MqttIngestionResult } from '../mqttIngestion.js';
import type {
  DbMqttPacket,
  MqttGroupedPacket,
  MqttGroupedQuery,
  MqttGateway,
  MqttIngestOutcome,
} from '../../db/repositories/mqttPacketLog.js';

/**
 * Service for the MQTT Packet Monitor — the multi-gateway-reception
 * analogue of `packetLogService` (Meshtastic TCP) and `meshcorePacketLogService`
 * (MeshCore OTA). Wraps `MqttPacketLogRepository`, exposes the opt-in
 * enable/retention settings (with a short TTL cache since MQTT ingest can be
 * high-throughput), and owns the ingestion hook's single write path
 * (`logEnvelope`) plus the periodic retention sweep (age + per-source count
 * cap). See docs/internal/dev-notes/MQTT_PACKET_MONITOR_PHASE1_SPEC.md §2.9.
 */
class MqttPacketLogService {
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private readonly CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
  private readonly DEFAULT_MAX_COUNT = 5000;
  private readonly DEFAULT_MAX_AGE_HOURS = 24;

  private enabledCache: { value: boolean; expires: number } | null = null;
  private readonly ENABLED_TTL_MS = 5000;

  constructor() {
    this.startCleanupScheduler();
  }

  private startCleanupScheduler(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    logger.debug('🧹 Starting MQTT packet log cleanup scheduler (runs every 15 minutes)');
    this.cleanupInterval = setInterval(() => {
      void this.runCleanup();
    }, this.CLEANUP_INTERVAL_MS);
  }

  /**
   * Remove rows older than the configured max age, then trim each source's
   * log down to the configured max count.
   */
  async runCleanup(): Promise<void> {
    try {
      const maxAgeHours = await this.getMaxAgeHours();
      const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
      let removed = await databaseService.mqttPacketLog.deletePacketsOlderThan(cutoff);

      const maxCount = await this.getMaxCount();
      const sourceIds = await databaseService.mqttPacketLog.getPacketLogSourceIds();
      for (const sourceId of sourceIds) {
        removed += await databaseService.mqttPacketLog.trimPacketsToCount(sourceId, maxCount);
      }

      if (removed > 0) {
        logger.debug(`🧹 MQTT packet log cleanup: removed ${removed} old packets`);
      }
    } catch (error) {
      logger.error('❌ Failed to cleanup MQTT packet logs:', error);
    }
  }

  /**
   * MQTT reception capture is opt-in and off by default. Cached for
   * `ENABLED_TTL_MS` so a high-throughput MQTT source doesn't hit the
   * settings table on every gateway copy.
   */
  async isEnabled(): Promise<boolean> {
    const now = Date.now();
    if (this.enabledCache && now < this.enabledCache.expires) {
      return this.enabledCache.value;
    }
    const value = (await databaseService.getSettingAsync('mqtt_packet_log_enabled')) === '1';
    this.enabledCache = { value, expires: now + this.ENABLED_TTL_MS };
    return value;
  }

  /** Test seam — clears the TTL cache so a just-written setting is observed immediately. */
  resetEnabledCache(): void {
    this.enabledCache = null;
  }

  async getMaxCount(): Promise<number> {
    const raw = await databaseService.getSettingAsync('mqtt_packet_log_max_count');
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : this.DEFAULT_MAX_COUNT;
  }

  async getMaxAgeHours(): Promise<number> {
    const raw = await databaseService.getSettingAsync('mqtt_packet_log_max_age_hours');
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : this.DEFAULT_MAX_AGE_HOURS;
  }

  /**
   * Ingestion entry point — the single method the `mqttIngestion.ts` hook
   * calls. Owns the enabled-gate, the row build, and the best-effort insert
   * so the hook itself stays a one-liner. Never throws — a logging failure
   * must not break the MQTT ingest pipeline.
   */
  async logEnvelope(
    sourceId: string,
    envelope: ServiceEnvelopeShape,
    result: MqttIngestionResult,
  ): Promise<void> {
    try {
      if (!envelope.packet) return; // nothing to log
      if (!(await this.isEnabled())) return; // no-op when disabled (cached)
      const row = buildMqttPacketLogRow(sourceId, envelope, result);
      if (!row) return;
      await databaseService.mqttPacketLog.insertPacket(row);
    } catch (err) {
      logger.error('❌ Failed to log MQTT packet:', err);
    }
  }

  async getGroupedPackets(q: MqttGroupedQuery): Promise<MqttGroupedPacket[]> {
    return databaseService.mqttPacketLog.getGroupedPackets(q);
  }

  async getGroupedPacketCount(q: MqttGroupedQuery): Promise<number> {
    return databaseService.mqttPacketLog.getGroupedPacketCount(q);
  }

  async getReceptions(sourceId: string, packetId: number, fromNode: number): Promise<DbMqttPacket[]> {
    return databaseService.mqttPacketLog.getReceptions(sourceId, packetId, fromNode);
  }

  async getGateways(sourceId: string): Promise<MqttGateway[]> {
    return databaseService.mqttPacketLog.getGateways(sourceId);
  }

  async clearPackets(sourceId?: string): Promise<number> {
    return databaseService.mqttPacketLog.deleteAllPackets(sourceId);
  }

  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
      logger.debug('🛑 Stopped MQTT packet log cleanup scheduler');
    }
  }
}

/**
 * Map an ingestion outcome from `mqttIngestion.ts` to the packet-log's
 * `ingestOutcome` enum.
 */
function mapOutcome(result: MqttIngestionResult): MqttIngestOutcome {
  if (result.ingested) return 'ingested';
  switch (result.reason) {
    case 'encrypted':
      return 'encrypted';
    case 'ignored':
      return 'ignored';
    case 'geo-ignored':
      return 'geo-ignored';
    case 'distance':
      return 'distance';
    case 'unsupported-portnum':
      return 'unsupported-portnum';
    case 'decode-error':
    case 'no-decoded':
    case 'no-packet':
    default:
      return 'decode-error';
  }
}

/**
 * Parse a `!aabbccdd`-formatted gateway id back into its numeric nodeNum.
 * Returns null for a missing/malformed id.
 */
function parseGatewayNodeNum(id: string | null | undefined): number | null {
  if (!id || !id.startsWith('!')) return null;
  const n = parseInt(id.slice(1), 16);
  return Number.isNaN(n) ? null : n >>> 0;
}

/**
 * Lightweight payload preview — text only. Position/telemetry summaries are
 * deferred to a later phase (no protobuf re-decode here).
 */
function buildPreview(portnum: number | null, payload: Uint8Array | undefined): string | null {
  if (portnum !== PortNum.TEXT_MESSAGE_APP || !payload) return null;
  return Buffer.from(payload).toString('utf8').slice(0, 256);
}

/**
 * Build the `mqtt_packet_log` row for one gateway reception. Pure function —
 * no DB/enabled concerns — so it is unit-testable in isolation. Returns null
 * when there's no packet to log.
 */
export function buildMqttPacketLogRow(
  sourceId: string,
  envelope: ServiceEnvelopeShape,
  result: MqttIngestionResult,
): DbMqttPacket | null {
  const p = envelope.packet;
  if (!p) return null;
  const now = Date.now();
  const num = (v: unknown): number | null => (typeof v === 'number' ? v >>> 0 : null);
  const fromNode = num(p.from);
  const toNode = num(p.to);
  const wasEncrypted = !!(p.encrypted && p.encrypted.length > 0);
  const decoded = p.decoded; // inner may have synthesized this on server-decrypt
  const portnum = typeof decoded?.portnum === 'number' ? decoded.portnum : null;
  const gatewayId = envelope.gatewayId ?? null;
  return {
    sourceId,
    packetId: num(p.id),
    fromNode,
    fromNodeId: fromNode !== null ? nodeNumToId(fromNode) : null,
    toNode,
    toNodeId: toNode !== null ? nodeNumToId(toNode) : null,
    channel: typeof p.channel === 'number' ? p.channel : null,
    channelId: envelope.channelId ?? null,
    gatewayId,
    gatewayNodeNum: parseGatewayNodeNum(gatewayId),
    timestamp: now,
    rxTime: typeof p.rxTime === 'number' && p.rxTime > 0 ? p.rxTime * 1000 : null,
    rxSnr: typeof p.rxSnr === 'number' ? p.rxSnr : null,
    rxRssi: typeof p.rxRssi === 'number' ? p.rxRssi : null,
    hopLimit: typeof p.hopLimit === 'number' ? p.hopLimit : null,
    hopStart: typeof p.hopStart === 'number' ? p.hopStart : null,
    portnum,
    portnumName: portnum !== null ? meshtasticProtobufService.getPortNumName(portnum) : null,
    encrypted: wasEncrypted ? 1 : 0,
    decryptedBy: wasEncrypted && decoded ? 'server' : null,
    ingestOutcome: mapOutcome(result),
    payloadSize: decoded?.payload?.length ?? (p.encrypted?.length ?? null),
    payloadPreview: buildPreview(portnum, decoded?.payload),
    createdAt: now,
  };
}

export default new MqttPacketLogService();
