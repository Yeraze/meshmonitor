import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { PortNum } from '../constants/meshtastic.js';
import meshtasticProtobufService from '../meshtasticProtobufService.js';
import { nodeNumToId, type ServiceEnvelopeShape } from '../mqttPacketFilter.js';
import type { MqttIngestionResult } from '../mqttIngestion.js';
import { detectOkToMqttViolation, parseGatewayNodeNum, type OkToMqttViolationEval } from '../utils/okToMqtt.js';
import type {
  DbMqttPacket,
  MqttGroupedPacket,
  MqttGroupedQuery,
  MqttGateway,
  MqttIngestOutcome,
} from '../../db/repositories/mqttPacketLog.js';
import type {
  DbMqttOkToMqttViolation,
  MqttViolationGateway,
  ViolationGatewaySort,
  ViolationListSort,
  ViolationRangeQuery,
} from '../../db/repositories/mqttOkToMqttViolations.js';

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
  private readonly DEFAULT_VIOLATION_RETENTION_DAYS = 90;
  private readonly DEFAULT_VIOLATION_MAX_COUNT = 50000;

  private enabledCache: { value: boolean; expires: number } | null = null;
  private readonly ENABLED_TTL_MS = 5000;

  private violationEnabledCache: { value: boolean; expires: number } | null = null;

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

    // Phase 2 (#4114): the durable ok_to_mqtt violations table has its own
    // retention — a different table, a different cutoff (default 90d vs
    // 24h), and a different per-source cap — deliberately independent of the
    // packet log's own sweep above so it survives even when the packet log
    // is disabled/cleared. See MQTT_OK_TO_MQTT_PHASE1_SPEC.md §2(d). Reuses
    // this same 15-minute timer — do NOT add a second `setInterval`.
    try {
      const days = await this.getViolationRetentionDays();
      const vCutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      let vRemoved = await databaseService.mqttOkToMqttViolations.deleteViolationsOlderThan(vCutoff);

      const vMax = await this.getViolationMaxCount();
      for (const sid of await databaseService.mqttOkToMqttViolations.getViolationSourceIds()) {
        vRemoved += await databaseService.mqttOkToMqttViolations.trimViolationsToCount(sid, vMax);
      }

      if (vRemoved > 0) {
        logger.debug(`🧹 MQTT ok_to_mqtt violations cleanup: removed ${vRemoved} old violations`);
      }
    } catch (error) {
      logger.error('❌ Failed to cleanup MQTT ok_to_mqtt violations:', error);
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
   * Kill switch for the durable ok_to_mqtt violation write (#4114). DEFAULT
   * ON, and — unlike every other enable flag in this file — INVERTED:
   * `=== '0'` means off; anything else, including unset, means on. This is
   * deliberate: the violation write must keep working on every existing
   * install that never touched settings, since the packet log itself
   * (`isEnabled()` above) is opt-in and default OFF. See
   * MQTT_OK_TO_MQTT_PHASE1_SPEC.md §2(g). Cached for `ENABLED_TTL_MS`.
   */
  async isViolationLogEnabled(): Promise<boolean> {
    const now = Date.now();
    if (this.violationEnabledCache && now < this.violationEnabledCache.expires) {
      return this.violationEnabledCache.value;
    }
    const raw = await databaseService.getSettingAsync('mqtt_oktomqtt_violation_log_enabled');
    const value = raw !== '0';
    this.violationEnabledCache = { value, expires: now + this.ENABLED_TTL_MS };
    return value;
  }

  /** Test seam — clears the TTL cache so a just-written setting is observed immediately. */
  resetViolationEnabledCache(): void {
    this.violationEnabledCache = null;
  }

  async getViolationRetentionDays(): Promise<number> {
    const raw = await databaseService.getSettingAsync('mqtt_oktomqtt_violation_retention_days');
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : this.DEFAULT_VIOLATION_RETENTION_DAYS;
  }

  async getViolationMaxCount(): Promise<number> {
    const raw = await databaseService.getSettingAsync('mqtt_oktomqtt_violation_max_count');
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : this.DEFAULT_VIOLATION_MAX_COUNT;
  }

  /**
   * Ingestion entry point — the single method the `mqttIngestion.ts` hook
   * calls. Owns the enabled-gate, the row build, and the best-effort insert
   * so the hook itself stays a one-liner. Never throws — a logging failure
   * must not break the MQTT ingest pipeline.
   *
   * The durable ok_to_mqtt violation write (#4114) is independent of the
   * packet-log opt-in: it has its own kill switch (default ON, see
   * {@link isViolationLogEnabled}) so Phase 3's report works out of the box
   * even on installs that never enabled the packet monitor. The eval is
   * computed once, with `localGatewayNodeNum`, and reused for both the
   * packet-log row and the violation row so they can never disagree.
   */
  async logEnvelope(
    sourceId: string,
    envelope: ServiceEnvelopeShape,
    result: MqttIngestionResult,
    topic?: string,
    localGatewayNodeNum?: number | null,
  ): Promise<void> {
    try {
      if (!envelope.packet) return; // nothing to log
      const v = detectOkToMqttViolation(envelope, localGatewayNodeNum); // pure, cheap, no await
      const packetLogEnabled = await this.isEnabled(); // cached, 5s TTL
      const wantViolation = v.isViolation && (await this.isViolationLogEnabled()); // cached
      if (!packetLogEnabled && !wantViolation) return; // fast path: nothing to write
      const row = buildMqttPacketLogRow(sourceId, envelope, result, topic, v);
      if (!row) return;
      if (wantViolation) {
        await databaseService.mqttOkToMqttViolations.insertViolation(buildViolationRow(row));
      }
      if (packetLogEnabled) {
        await databaseService.mqttPacketLog.insertPacket(row);
      }
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

  async getViolationGatewaySummary(
    q: ViolationRangeQuery & { sort?: ViolationGatewaySort; dir?: 'asc' | 'desc' },
  ): Promise<MqttViolationGateway[]> {
    return databaseService.mqttOkToMqttViolations.getGatewaySummary(q);
  }

  async getViolationGatewaySummaryCount(q: ViolationRangeQuery): Promise<number> {
    return databaseService.mqttOkToMqttViolations.getGatewaySummaryCount(q);
  }

  async getViolationGatewaySourceIds(
    q: ViolationRangeQuery,
  ): Promise<Array<{ gatewayId: string; sourceId: string }>> {
    return databaseService.mqttOkToMqttViolations.getGatewaySourceIds(q);
  }

  async getViolations(
    q: ViolationRangeQuery & { sort?: ViolationListSort; dir?: 'asc' | 'desc' },
  ): Promise<DbMqttOkToMqttViolation[]> {
    return databaseService.mqttOkToMqttViolations.getViolations(q);
  }

  async getViolationCount(q: ViolationRangeQuery): Promise<number> {
    return databaseService.mqttOkToMqttViolations.getViolationCount(q);
  }

  async getSuspectedViolations(q: {
    sourceIds: string[];
    since: number;
    until: number;
    gatewayId?: string;
    limit?: number;
    offset?: number;
  }): Promise<DbMqttPacket[]> {
    return databaseService.mqttPacketLog.getSuspectedViolations(q);
  }

  async getSuspectedViolationGateways(q: { sourceIds: string[]; since: number; until: number }): Promise<
    Array<{
      gatewayId: string | null;
      gatewayNodeNum: number | null;
      suspectedCount: number;
      distinctOriginators: number;
      firstSeen: number;
      lastSeen: number;
    }>
  > {
    return databaseService.mqttPacketLog.getSuspectedViolationGateways(q);
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
  topic?: string,
  evaluated?: OkToMqttViolationEval,
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
  // `evaluated` is the already-computed eval from `logEnvelope` (which knows
  // `localGatewayNodeNum`, the self-echo guard of §2(f.1)). Direct unit-test
  // callers that omit it fall back to a no-local-identity eval — the guard
  // then simply doesn't apply, which is the correct default for a caller
  // with no local identity to compare against (#4114).
  const v = evaluated ?? detectOkToMqttViolation(envelope);
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
    bitfield: v.bitfield,
    okToMqttViolation: v.isViolation ? 1 : 0,
    topic: topic ?? null,
    createdAt: now,
  };
}

/**
 * Project a packet-log row onto the durable violation row (#4114). Pure
 * field projection off the already-built `DbMqttPacket` — deliberately NOT
 * derived independently from the envelope, so the packet-log row and the
 * durable violation row can never disagree. Caller has already established
 * `row.okToMqttViolation === 1`.
 */
export function buildViolationRow(row: DbMqttPacket): DbMqttOkToMqttViolation {
  return {
    sourceId: row.sourceId,
    packetId: row.packetId ?? null,
    fromNode: row.fromNode ?? null,
    fromNodeId: row.fromNodeId ?? null,
    gatewayId: row.gatewayId ?? null,
    gatewayNodeNum: row.gatewayNodeNum ?? null,
    channelId: row.channelId ?? null,
    portnum: row.portnum ?? null,
    portnumName: row.portnumName ?? null,
    bitfield: row.bitfield ?? null,
    topic: row.topic ?? null,
    rxTime: row.rxTime ?? null,
    timestamp: row.timestamp,
    createdAt: row.createdAt,
  };
}

export default new MqttPacketLogService();
