/**
 * MQTT Packet Log Repository
 *
 * `mqtt_packet_log` (migration 120) is a reception log: one row per gateway
 * copy of an MQTT-bridged Meshtastic ServiceEnvelope. MQTT's defining trait
 * is N receptions per packet — one per gateway — so the list view is a
 * query-time dedup/group over `(sourceId, fromNode, packetId)` with a
 * per-gateway detail drill-down (`getReceptions`) and a gateway summary
 * (`getGateways`). See docs/internal/dev-notes/MQTT_PACKET_MONITOR_PHASE1_SPEC.md
 * §2.6/§3 for the design this file implements verbatim.
 */
import { eq, and, gte, lt, asc, desc, isNotNull, inArray, sql, type SQL } from 'drizzle-orm';
import { BaseRepository } from './base.js';

export type MqttIngestOutcome =
  | 'ingested'
  | 'encrypted'
  | 'ignored'
  | 'geo-ignored'
  | 'distance'
  | 'unsupported-portnum'
  | 'decode-error';

export interface DbMqttPacket {
  id?: number;
  sourceId: string; // required on writes
  packetId?: number | null;
  fromNode?: number | null;
  fromNodeId?: string | null;
  toNode?: number | null;
  toNodeId?: string | null;
  channel?: number | null; // wire channel-hash byte
  channelId?: string | null; // envelope channel name
  gatewayId?: string | null;
  gatewayNodeNum?: number | null;
  timestamp: number; // server receive ms
  rxTime?: number | null;
  rxSnr?: number | null;
  rxRssi?: number | null;
  hopLimit?: number | null;
  hopStart?: number | null;
  portnum?: number | null;
  portnumName?: string | null;
  encrypted: number; // 0 | 1
  decryptedBy?: string | null; // 'server' | null
  ingestOutcome: MqttIngestOutcome;
  payloadSize?: number | null;
  payloadPreview?: string | null;
  createdAt: number;
}

/** Filters shared by grouped list + count. `sourceId` is required (enforced by caller). */
export interface MqttGroupedQuery {
  sourceId: string;
  gateways?: string[]; // gatewayId IN (...)
  portnum?: number;
  since?: number; // timestamp >= since (ms)
  encrypted?: boolean; // true -> encrypted=1, false -> encrypted=0
  limit?: number;
  offset?: number;
}

/** One deduplicated packet (a group of gateway receptions). */
export interface MqttGroupedPacket {
  packetId: number | null;
  fromNode: number | null;
  fromNodeId: string | null;
  toNode: number | null;
  toNodeId: string | null;
  channel: number | null;
  channelId: string | null;
  portnum: number | null;
  portnumName: string | null;
  encrypted: number; // representative (MAX)
  ingestOutcome: string;
  payloadSize: number | null;
  payloadPreview: string | null;
  gatewayCount: number; // COUNT(DISTINCT gatewayId)
  receptionCount: number; // COUNT(*)
  firstHeard: number; // MIN(timestamp)
  lastHeard: number; // MAX(timestamp)
}

export interface MqttGateway {
  gatewayId: string;
  gatewayNodeNum: number | null;
  receptionCount: number;
  lastHeard: number;
}

/**
 * Repository for the MQTT packet monitor's reception log.
 */
export class MqttPacketLogRepository extends BaseRepository {
  /**
   * Insert one gateway-reception row. `sourceId` is required so every row is
   * stamped with its owning source.
   */
  async insertPacket(packet: DbMqttPacket): Promise<void> {
    if (!packet.sourceId) {
      throw new Error('MqttPacketLogRepository.insertPacket requires a sourceId');
    }
    const { mqttPacketLog } = this.tables;
    await this.db.insert(mqttPacketLog).values(packet);
  }

  /**
   * Build the WHERE conditions shared by the grouped list, grouped count,
   * and (indirectly) the gateway-filtered gatewayCount.
   */
  private buildGroupedConditions(q: MqttGroupedQuery): SQL[] {
    const { mqttPacketLog } = this.tables;
    const conditions: SQL[] = [eq(mqttPacketLog.sourceId, q.sourceId)];
    if (q.gateways && q.gateways.length > 0) {
      conditions.push(inArray(mqttPacketLog.gatewayId, q.gateways));
    }
    if (typeof q.portnum === 'number') {
      conditions.push(eq(mqttPacketLog.portnum, q.portnum));
    }
    if (typeof q.since === 'number') {
      conditions.push(gte(mqttPacketLog.timestamp, q.since));
    }
    if (q.encrypted !== undefined) {
      conditions.push(eq(mqttPacketLog.encrypted, q.encrypted ? 1 : 0));
    }
    return conditions;
  }

  /**
   * Query deduplicated packets (one row per `(sourceId, fromNode, packetId)`
   * group, collapsing per-gateway receptions), newest-first, with pagination.
   *
   * Group key handles the packetId 0/null edge: `COALESCE(NULLIF(packetId,0), -id)`
   * — a real packetId (>0) groups normally; 0/null packetIds each become their
   * own singleton group via the negative `-id` fallback (id is unique, and
   * negative can never collide with a positive packetId).
   */
  async getGroupedPackets(q: MqttGroupedQuery): Promise<MqttGroupedPacket[]> {
    const t = this.tables.mqttPacketLog;
    const groupKey = sql`COALESCE(NULLIF(${t.packetId}, 0), -${t.id})`;
    const conditions = this.buildGroupedConditions(q);
    const rows = await this.db
      .select({
        packetId: sql<number | null>`MAX(${t.packetId})`,
        fromNode: t.fromNode,
        fromNodeId: sql<string | null>`MAX(${t.fromNodeId})`,
        toNode: sql<number | null>`MAX(${t.toNode})`,
        toNodeId: sql<string | null>`MAX(${t.toNodeId})`,
        channel: sql<number | null>`MAX(${t.channel})`,
        channelId: sql<string | null>`MAX(${t.channelId})`,
        portnum: sql<number | null>`MAX(${t.portnum})`,
        portnumName: sql<string | null>`MAX(${t.portnumName})`,
        encrypted: sql<number>`MAX(${t.encrypted})`,
        ingestOutcome: sql<string>`MAX(${t.ingestOutcome})`,
        payloadSize: sql<number | null>`MAX(${t.payloadSize})`,
        payloadPreview: sql<string | null>`MAX(${t.payloadPreview})`,
        gatewayCount: sql<number>`COUNT(DISTINCT ${t.gatewayId})`,
        receptionCount: sql<number>`COUNT(*)`,
        firstHeard: sql<number>`MIN(${t.timestamp})`,
        lastHeard: sql<number>`MAX(${t.timestamp})`,
      })
      .from(t)
      .where(and(...conditions))
      .groupBy(t.sourceId, t.fromNode, groupKey)
      .orderBy(sql`MAX(${t.timestamp}) DESC`)
      .limit(q.limit ?? 100)
      .offset(q.offset ?? 0);
    return this.normalizeBigInts(rows) as unknown as MqttGroupedPacket[];
  }

  /**
   * Count the number of groups matching the same filters as
   * {@link getGroupedPackets}, without pagination. Uses a subquery over the
   * grouped rows — portable across SQLite/PostgreSQL/MySQL, unlike
   * `COUNT(DISTINCT expr1, expr2)` which MySQL doesn't support.
   */
  async getGroupedPacketCount(q: MqttGroupedQuery): Promise<number> {
    const t = this.tables.mqttPacketLog;
    const groupKey = sql`COALESCE(NULLIF(${t.packetId}, 0), -${t.id})`;
    const conditions = this.buildGroupedConditions(q);
    const grouped = this.db
      .select({ k: sql`1` })
      .from(t)
      .where(and(...conditions))
      .groupBy(t.sourceId, t.fromNode, groupKey)
      .as('grouped');
    const res = await this.db.select({ count: sql<number>`COUNT(*)` }).from(grouped);
    return Number(res[0]?.count ?? 0);
  }

  /**
   * Per-gateway reception detail for one packet group, oldest-first.
   *
   * packetId 0/null edge (see class docs and the spec's §6.1): this filters on
   * the literal stored `packetId`, so a call with `packetId=0` will match every
   * zero-id row for `fromNode` rather than one specific group. This is an
   * accepted, documented limitation — real mesh packets essentially always
   * carry a nonzero id.
   */
  async getReceptions(sourceId: string, packetId: number, fromNode: number): Promise<DbMqttPacket[]> {
    const { mqttPacketLog } = this.tables;
    const rows = await this.db
      .select()
      .from(mqttPacketLog)
      .where(
        and(
          eq(mqttPacketLog.sourceId, sourceId),
          eq(mqttPacketLog.fromNode, fromNode),
          eq(mqttPacketLog.packetId, packetId),
        ),
      )
      .orderBy(asc(mqttPacketLog.timestamp), asc(mqttPacketLog.id));
    return this.normalizeBigInts(rows) as unknown as DbMqttPacket[];
  }

  /**
   * Distinct gateways that have reported for a source, with reception count
   * and last-heard time — powers the gateway filter UI.
   */
  async getGateways(sourceId: string): Promise<MqttGateway[]> {
    const t = this.tables.mqttPacketLog;
    const rows = await this.db
      .select({
        gatewayId: t.gatewayId,
        gatewayNodeNum: sql<number | null>`MAX(${t.gatewayNodeNum})`,
        receptionCount: sql<number>`COUNT(*)`,
        lastHeard: sql<number>`MAX(${t.timestamp})`,
      })
      .from(t)
      .where(and(eq(t.sourceId, sourceId), isNotNull(t.gatewayId)))
      .groupBy(t.gatewayId)
      .orderBy(sql`MAX(${t.timestamp}) DESC`);
    return this.normalizeBigInts(rows) as unknown as MqttGateway[];
  }

  /**
   * Raw row count (receptions, not groups), optionally scoped to one source.
   * Used by retention (count-based trim).
   */
  async getPacketCount(query: { sourceId?: string } = {}): Promise<number> {
    const { mqttPacketLog } = this.tables;
    const whereClause = query.sourceId ? eq(mqttPacketLog.sourceId, query.sourceId) : undefined;
    const result = await this.db
      .select({ count: sql<number>`COUNT(*)` })
      .from(mqttPacketLog)
      .where(whereClause);
    return Number(result[0]?.count ?? 0);
  }

  /**
   * Delete reception rows older than a timestamp (ms). Returns rows removed.
   */
  async deletePacketsOlderThan(timestamp: number, sourceId?: string): Promise<number> {
    const { mqttPacketLog } = this.tables;
    const conditions: SQL[] = [lt(mqttPacketLog.timestamp, timestamp)];
    if (sourceId) {
      conditions.push(eq(mqttPacketLog.sourceId, sourceId));
    }
    const before = await this.getPacketCount({ sourceId });
    await this.db.delete(mqttPacketLog).where(and(...conditions));
    const after = await this.getPacketCount({ sourceId });
    return Math.max(0, before - after);
  }

  /**
   * Trim a source's reception log down to its newest `maxCount` rows.
   * Returns the number of rows removed.
   */
  async trimPacketsToCount(sourceId: string, maxCount: number): Promise<number> {
    if (!sourceId || maxCount <= 0) return 0;
    const { mqttPacketLog } = this.tables;
    const total = await this.getPacketCount({ sourceId });
    if (total <= maxCount) return 0;

    // Find the cutoff id: keep the newest `maxCount` rows, delete the rest.
    const survivors = await this.db
      .select({ id: mqttPacketLog.id })
      .from(mqttPacketLog)
      .where(eq(mqttPacketLog.sourceId, sourceId))
      .orderBy(desc(mqttPacketLog.timestamp), desc(mqttPacketLog.id))
      .limit(maxCount);
    if (survivors.length === 0) return 0;
    const oldestKeptId = Number(survivors[survivors.length - 1].id);

    await this.db
      .delete(mqttPacketLog)
      .where(and(eq(mqttPacketLog.sourceId, sourceId), lt(mqttPacketLog.id, oldestKeptId)));
    return total - survivors.length;
  }

  /**
   * Distinct source ids currently present in the packet log (for per-source
   * retention trimming).
   */
  async getPacketLogSourceIds(): Promise<string[]> {
    const { mqttPacketLog } = this.tables;
    const rows = await this.db
      .selectDistinct({ sourceId: mqttPacketLog.sourceId })
      .from(mqttPacketLog);
    return rows.map((r: { sourceId: string }) => r.sourceId).filter(Boolean);
  }

  /**
   * Delete all reception rows, optionally scoped to one source.
   * Returns the number of rows removed.
   */
  async deleteAllPackets(sourceId?: string): Promise<number> {
    const { mqttPacketLog } = this.tables;
    const count = await this.getPacketCount({ sourceId });
    if (sourceId) {
      await this.db.delete(mqttPacketLog).where(eq(mqttPacketLog.sourceId, sourceId));
    } else {
      await this.db.delete(mqttPacketLog);
    }
    return count;
  }
}
