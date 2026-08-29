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
import { eq, ne, and, gte, gt, lte, lt, asc, desc, isNull, isNotNull, inArray, max, sql, type SQL } from 'drizzle-orm';
import { BaseRepository } from './base.js';
import { HOP_ARRIVAL_MAX_ROWS, type PacketHopArrivalRow } from './packetLog.js';

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
  /** Raw `Data.bitfield` (protobuf field 9). NULL = absent/undecryptable = ok_to_mqtt unknown (#4114). */
  bitfield?: number | null;
  /** 0/1, NOT a boolean column — MAX(okToMqttViolation) in the grouped query needs an int (#4114). */
  okToMqttViolation: number; // 0 | 1
  /** Raw MQTT topic this reception arrived on. Diagnostic (#4114). */
  topic?: string | null;
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
  bitfield: number | null; // representative (MAX) — exact: the field is the originator's
  okToMqttViolation: number; // MAX — 1 => at least one gateway violated
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
 * Per-`(gateway, node)` DIRECT-reception aggregate — Mesh Issues RF evidence
 * class 3 (Phase 2 §3.1). `gatewayNodeNum`/`fromNode` are the parsed node
 * numbers (not the `!hex` id strings), because `buildRfGraph` keys its graph
 * by numeric nodeNum.
 */
export interface MqttDirectReceptionRow {
  gatewayNodeNum: number;
  fromNode: number;
  sourceId: string;
  receptionCount: number;
  meanRxSnr: number | null;
  firstSeen: number;
  lastSeen: number;
}

/**
 * Row cap for {@link MqttPacketLogRepository.getDirectReceptionsByGateway}
 * (Mesh Issues Phase 2 §2.9's `MQTT_DIRECT_RECEPTION_MAX_ROWS`). Exported so
 * callers — including the Mesh Issues analysis service — can reference the
 * same bound rather than re-declaring it. `[ours]`.
 */
export const MQTT_DIRECT_RECEPTION_MAX_ROWS = 20_000;

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
        bitfield: sql<number | null>`MAX(${t.bitfield})`,
        okToMqttViolation: sql<number>`MAX(${t.okToMqttViolation})`,
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
   * Suspected ok_to_mqtt violations (#4114): relayed receptions whose bit was
   * unreadable (`bitfield IS NULL`). Bounded by this table's retention
   * window — see MQTT_OK_TO_MQTT_PHASE1_SPEC.md §2(e). Excludes
   * self-published rows (`gatewayNodeNum === fromNode`) and rows where
   * either identity is unknown, since relaying cannot be proven for those.
   */
  async getSuspectedViolations(q: {
    sourceIds: string[];
    since: number;
    until: number;
    gatewayId?: string;
    limit?: number;
    offset?: number;
  }): Promise<DbMqttPacket[]> {
    if (q.sourceIds.length === 0) return [];
    const t = this.tables.mqttPacketLog;
    const conditions: SQL[] = [
      inArray(t.sourceId, q.sourceIds),
      isNull(t.bitfield),
      isNotNull(t.gatewayNodeNum),
      isNotNull(t.fromNode),
      sql`${t.gatewayNodeNum} <> ${t.fromNode}`,
      gte(t.timestamp, q.since),
      lte(t.timestamp, q.until),
    ];
    if (q.gatewayId) {
      conditions.push(eq(t.gatewayId, q.gatewayId));
    }
    const rows = await this.db
      .select()
      .from(t)
      .where(and(...conditions))
      .orderBy(desc(t.timestamp))
      .limit(q.limit ?? 500)
      .offset(q.offset ?? 0);
    return this.normalizeBigInts(rows) as unknown as DbMqttPacket[];
  }

  /**
   * Per-gateway aggregate over the same "suspected" predicate as
   * {@link getSuspectedViolations} — powers the `includeUnknown` merge on
   * the gateway summary route.
   */
  async getSuspectedViolationGateways(q: {
    sourceIds: string[];
    since: number;
    until: number;
  }): Promise<
    Array<{
      gatewayId: string | null;
      gatewayNodeNum: number | null;
      suspectedCount: number;
      distinctOriginators: number;
      firstSeen: number;
      lastSeen: number;
    }>
  > {
    if (q.sourceIds.length === 0) return [];
    const t = this.tables.mqttPacketLog;
    const conditions: SQL[] = [
      inArray(t.sourceId, q.sourceIds),
      isNull(t.bitfield),
      isNotNull(t.gatewayNodeNum),
      isNotNull(t.fromNode),
      sql`${t.gatewayNodeNum} <> ${t.fromNode}`,
      gte(t.timestamp, q.since),
      lte(t.timestamp, q.until),
    ];
    const rows = await this.db
      .select({
        gatewayId: t.gatewayId,
        gatewayNodeNum: sql<number | null>`MAX(${t.gatewayNodeNum})`,
        suspectedCount: sql<number>`COUNT(*)`,
        distinctOriginators: sql<number>`COUNT(DISTINCT ${t.fromNode})`,
        firstSeen: sql<number>`MIN(${t.timestamp})`,
        lastSeen: sql<number>`MAX(${t.timestamp})`,
      })
      .from(t)
      .where(and(...conditions))
      .groupBy(t.gatewayId);
    return this.normalizeBigInts(rows) as unknown as Array<{
      gatewayId: string | null;
      gatewayNodeNum: number | null;
      suspectedCount: number;
      distinctOriginators: number;
      firstSeen: number;
      lastSeen: number;
    }>;
  }

  /**
   * Distinct `(gatewayId, sourceId)` pairs over the same "suspected"
   * predicate as {@link getSuspectedViolationGateways} — powers the
   * per-gateway `sourceIds` array for suspected-only gateways on the
   * `/mqtt-violations/gateways` route (#4114). `sourceId` can't be added to
   * that method's aggregate projection ungrouped (MySQL `ONLY_FULL_GROUP_BY`),
   * so this mirrors `MqttOkToMqttViolationsRepository.getGatewaySourceIds`,
   * which exists for the identical reason on the confirmed-violations side.
   */
  async getSuspectedGatewaySourceIds(q: {
    sourceIds: string[];
    since: number;
    until: number;
  }): Promise<Array<{ gatewayId: string; sourceId: string }>> {
    if (q.sourceIds.length === 0) return [];
    const t = this.tables.mqttPacketLog;
    const conditions: SQL[] = [
      inArray(t.sourceId, q.sourceIds),
      isNull(t.bitfield),
      isNotNull(t.gatewayNodeNum),
      isNotNull(t.fromNode),
      sql`${t.gatewayNodeNum} <> ${t.fromNode}`,
      gte(t.timestamp, q.since),
      lte(t.timestamp, q.until),
    ];
    const rows = await this.db
      .selectDistinct({ gatewayId: t.gatewayId, sourceId: t.sourceId })
      .from(t)
      .where(and(...conditions));
    return (rows as Array<{ gatewayId: string | null; sourceId: string }>).filter(
      (r): r is { gatewayId: string; sourceId: string } => r.gatewayId != null,
    );
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

  /**
   * Per-`(gateway, node)` DIRECT receptions in-window — Mesh Issues RF
   * evidence class 3 (Phase 2 §3.1). "Direct" is `hopLimit = hopStart AND
   * hopStart > 0`: no hop was consumed, and `hopStart = 0` means UNKNOWN,
   * never direct (the epic's hop-delta guard). This is the same predicate
   * `NeighborsRepository.getDirectNeighborRssiAsync` uses against
   * `packet_log` — reused as the precedent, not as the query, because that
   * one is RSSI-oriented, single-source, and not grouped by gateway.
   *
   * CAVEAT for the caller: `hopStart - hopLimit` is a LOWER bound, because
   * firmware 2.7+ zero-cost favourite-router hops skip the decrement. So a
   * small number of genuinely multi-hop packets will look direct. This
   * over-counts adjacency slightly; rules treat gateway evidence as weaker
   * than `neighbor_info` for exactly this reason.
   *
   * Grouped by `(sourceId, gatewayNodeNum, fromNode)` — every non-aggregated
   * selected column is in the GROUP BY, so this is safe under MySQL's
   * `ONLY_FULL_GROUP_BY`. Ordered by `receptionCount` descending before the
   * cap is applied, so if the cap bites, the strongest evidence survives.
   */
  async getDirectReceptionsByGateway(q: {
    sourceIds: string[];
    since: number;
    limit?: number;
  }): Promise<MqttDirectReceptionRow[]> {
    if (q.sourceIds.length === 0) return [];

    const t = this.tables.mqttPacketLog;
    const rows = await this.db
      .select({
        gatewayNodeNum: t.gatewayNodeNum,
        fromNode: t.fromNode,
        sourceId: t.sourceId,
        receptionCount: sql<number>`COUNT(*)`,
        meanRxSnr: sql<number | null>`AVG(${t.rxSnr})`,
        firstSeen: sql<number>`MIN(${t.timestamp})`,
        lastSeen: sql<number>`MAX(${t.timestamp})`,
      })
      .from(t)
      .where(
        and(
          inArray(t.sourceId, q.sourceIds),
          gte(t.timestamp, q.since),
          isNotNull(t.gatewayNodeNum),
          isNotNull(t.fromNode),
          ne(t.gatewayNodeNum, t.fromNode),
          eq(t.hopLimit, t.hopStart),
          gt(t.hopStart, 0),
        ),
      )
      .groupBy(t.sourceId, t.gatewayNodeNum, t.fromNode)
      .orderBy(sql`COUNT(*) DESC`)
      .limit(q.limit ?? MQTT_DIRECT_RECEPTION_MAX_ROWS);

    // Explicit Number() coercion, not just normalizeBigInts: PostgreSQL's
    // driver returns BIGINT-derived aggregates (COUNT/MIN/MAX on a bigint
    // column) as strings by default, which normalizeBigInts (typeof
    // 'bigint' only) would not catch. meanRxSnr is AVG() over a real/double
    // column, which some drivers also stringify — coerced the same way,
    // preserving null.
    return (
      rows as Array<{
        gatewayNodeNum: unknown;
        fromNode: unknown;
        sourceId: string;
        receptionCount: unknown;
        meanRxSnr: unknown;
        firstSeen: unknown;
        lastSeen: unknown;
      }>
    ).map((r) => ({
      gatewayNodeNum: Number(r.gatewayNodeNum),
      fromNode: Number(r.fromNode),
      sourceId: r.sourceId,
      receptionCount: Number(r.receptionCount),
      meanRxSnr: r.meanRxSnr == null ? null : Number(r.meanRxSnr),
      firstSeen: Number(r.firstSeen),
      lastSeen: Number(r.lastSeen),
    }));
  }

  /**
   * Per-node hop-arrival stats since `since` — Mesh Issues B6 "hop horizon"
   * evidence (Phase 2 §3.2), MQTT variant. Mirrors
   * `PacketLogRepository.getHopArrivalCountsSince` exactly, except: every
   * `mqtt_packet_log` row is already a reception (there is no `direction`
   * column to filter), and `sourceIds` is required here rather than
   * optional. See that method's doc comment for the dedup rationale (D9 —
   * `MAX(hopLimit)` per `(fromNode, packetId)`, the conservative tie-break).
   */
  async getHopArrivalCountsSince(q: {
    since: number;
    sourceIds: string[];
    limit?: number;
  }): Promise<PacketHopArrivalRow[]> {
    if (q.sourceIds.length === 0) return [];

    const t = this.tables.mqttPacketLog;
    const conditions: SQL[] = [
      inArray(t.sourceId, q.sourceIds),
      gte(t.timestamp, q.since),
      isNotNull(t.fromNode),
      isNotNull(t.packetId),
      isNotNull(t.hopLimit),
      isNotNull(t.hopStart),
      gt(t.hopStart, 0),
    ];

    const deduped = this.db
      .select({
        nodeNum: t.fromNode,
        pid: t.packetId,
        maxHopLimit: max(t.hopLimit).as('maxHopLimit'),
      })
      .from(t)
      .where(and(...conditions))
      .groupBy(t.fromNode, t.packetId)
      .as('deduped');

    const rows = await this.db
      .select({
        nodeNum: deduped.nodeNum,
        totalPackets: sql<number>`COUNT(*)`,
        exhaustedPackets: sql<number>`SUM(CASE WHEN ${deduped.maxHopLimit} = 0 THEN 1 ELSE 0 END)`,
      })
      .from(deduped)
      .groupBy(deduped.nodeNum)
      .orderBy(sql`COUNT(*) DESC`)
      .limit(q.limit ?? HOP_ARRIVAL_MAX_ROWS);

    return (rows as Array<{ nodeNum: unknown; totalPackets: unknown; exhaustedPackets: unknown }>).map((r) => ({
      nodeNum: Number(r.nodeNum),
      totalPackets: Number(r.totalPackets),
      exhaustedPackets: Number(r.exhaustedPackets),
    }));
  }
}
