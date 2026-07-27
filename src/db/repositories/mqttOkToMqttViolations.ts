/**
 * MQTT `ok_to_mqtt` Violations Repository
 *
 * `mqtt_ok_to_mqtt_violations` (migration 128) is a durable, retention-immune
 * history of *confirmed* `ok_to_mqtt` violations — a gateway relayed another
 * node's packet to MQTT while that packet's `Data.bitfield` bit 0 was
 * explicitly clear. It is deliberately a separate table (and repository)
 * from `mqtt_packet_log`: the packet log trims to 24h / 5,000 rows, while
 * this table needs a weeks-long lookback for Phase 3's violation report. See
 * docs/internal/dev-notes/MQTT_OK_TO_MQTT_PHASE1_SPEC.md §1.9/§2(d)/§3.8.
 */
import { eq, and, gte, lte, lt, asc, desc, inArray, sql, type SQL } from 'drizzle-orm';
import { BaseRepository } from './base.js';

export interface DbMqttOkToMqttViolation {
  id?: number;
  sourceId: string; // required on writes
  packetId?: number | null;
  fromNode?: number | null;
  fromNodeId?: string | null;
  gatewayId?: string | null;
  gatewayNodeNum?: number | null;
  channelId?: string | null;
  portnum?: number | null;
  portnumName?: string | null;
  bitfield?: number | null;
  topic?: string | null;
  rxTime?: number | null;
  timestamp: number; // server capture ms
  createdAt: number;
}

export type ViolationGatewaySort = 'violationCount' | 'lastSeen' | 'distinctOriginators' | 'gatewayId';
export type ViolationListSort = 'timestamp' | 'fromNode' | 'gatewayId';

/** Explicit cross-source filter set. An empty `sourceIds` array is a guaranteed empty result. */
export interface ViolationRangeQuery {
  sourceIds: string[];
  since: number; // ms epoch, inclusive
  until: number; // ms epoch, inclusive
  gatewayId?: string;
  limit?: number;
  offset?: number;
}

export interface MqttViolationGateway {
  gatewayId: string | null;
  gatewayNodeNum: number | null;
  violationCount: number;
  distinctOriginators: number;
  firstSeen: number;
  lastSeen: number;
}

const DEFAULT_LIMIT = 500;

/**
 * Repository for the durable `ok_to_mqtt` violation history.
 */
export class MqttOkToMqttViolationsRepository extends BaseRepository {
  /**
   * Insert one confirmed-violation row. `sourceId` is required so every row
   * is stamped with its owning source.
   *
   * Dedupe: the unique index on `(sourceId, packetId, fromNode,
   * gatewayNodeNum)` makes re-ingest of the same reception a no-op — first
   * write wins, so `timestamp` records first observation. MySQL has no
   * `onConflictDoNothing`, so the idiomatic no-op there is assigning a
   * column to itself.
   */
  async insertViolation(v: DbMqttOkToMqttViolation): Promise<void> {
    if (!v.sourceId) {
      throw new Error('MqttOkToMqttViolationsRepository.insertViolation requires a sourceId');
    }
    const { mqttOkToMqttViolations } = this.tables;
    if (this.dbType === 'mysql') {
      await this.db
        .insert(mqttOkToMqttViolations)
        .values(v)
        .onDuplicateKeyUpdate({ set: { timestamp: sql`timestamp` } });
    } else {
      await this.db.insert(mqttOkToMqttViolations).values(v).onConflictDoNothing();
    }
  }

  /**
   * Build the WHERE conditions shared by every cross-source range query.
   * Callers MUST guard `sourceIds.length === 0` themselves before calling
   * this — an empty `inArray` is a dialect-dependent hazard.
   */
  private buildRangeConditions(q: ViolationRangeQuery): SQL[] {
    const t = this.tables.mqttOkToMqttViolations;
    const conditions: SQL[] = [
      inArray(t.sourceId, q.sourceIds),
      gte(t.timestamp, q.since),
      lte(t.timestamp, q.until),
    ];
    if (q.gatewayId) {
      conditions.push(eq(t.gatewayId, q.gatewayId));
    }
    return conditions;
  }

  /**
   * Per-gateway summary over a time range: violation count, distinct
   * originators, first/last seen. `sourceId` is deliberately NOT selected
   * ungrouped (MySQL `ONLY_FULL_GROUP_BY`) — callers assemble per-gateway
   * `sourceIds` separately via {@link getGatewaySourceIds}.
   */
  async getGatewaySummary(
    q: ViolationRangeQuery & { sort?: ViolationGatewaySort; dir?: 'asc' | 'desc' },
  ): Promise<MqttViolationGateway[]> {
    if (q.sourceIds.length === 0) return [];
    const t = this.tables.mqttOkToMqttViolations;
    const conditions = this.buildRangeConditions(q);
    // Single-argument COUNT(DISTINCT …) only — MySQL rejects the multi-arg
    // form (see the same comment in mqttPacketLog.ts near getGroupedPacketCount).
    const sortExprMap: Record<ViolationGatewaySort, SQL> = {
      violationCount: sql`COUNT(*)`,
      lastSeen: sql`MAX(${t.timestamp})`,
      distinctOriginators: sql`COUNT(DISTINCT ${t.fromNode})`,
      gatewayId: sql`${t.gatewayId}`,
    };
    // ORDER BY is built from this whitelist, never interpolated from raw user input.
    const orderExpr = sortExprMap[q.sort ?? 'violationCount'];
    const orderFn = q.dir === 'asc' ? asc : desc;
    const rows = await this.db
      .select({
        gatewayId: t.gatewayId,
        gatewayNodeNum: sql<number | null>`MAX(${t.gatewayNodeNum})`,
        violationCount: sql<number>`COUNT(*)`,
        distinctOriginators: sql<number>`COUNT(DISTINCT ${t.fromNode})`,
        firstSeen: sql<number>`MIN(${t.timestamp})`,
        lastSeen: sql<number>`MAX(${t.timestamp})`,
      })
      .from(t)
      .where(and(...conditions))
      .groupBy(t.gatewayId)
      .orderBy(orderFn(orderExpr))
      .limit(q.limit ?? DEFAULT_LIMIT)
      .offset(q.offset ?? 0);
    return this.normalizeBigInts(rows) as unknown as MqttViolationGateway[];
  }

  /**
   * Count the number of gateway groups matching the same filters as
   * {@link getGatewaySummary}, without pagination. Subquery-over-grouped —
   * portable across SQLite/PostgreSQL/MySQL, unlike `COUNT(DISTINCT a,b)`
   * which MySQL doesn't support.
   */
  async getGatewaySummaryCount(q: ViolationRangeQuery): Promise<number> {
    if (q.sourceIds.length === 0) return 0;
    const t = this.tables.mqttOkToMqttViolations;
    const conditions = this.buildRangeConditions(q);
    const grouped = this.db
      .select({ k: sql`1` })
      .from(t)
      .where(and(...conditions))
      .groupBy(t.gatewayId)
      .as('grouped');
    const res = await this.db.select({ count: sql<number>`COUNT(*)` }).from(grouped);
    return Number(res[0]?.count ?? 0);
  }

  /**
   * Distinct `(gatewayId, sourceId)` pairs over a range — powers the
   * per-gateway `sourceIds` array on the summary response without putting
   * an ungrouped `sourceId` into the aggregate projection.
   */
  async getGatewaySourceIds(q: ViolationRangeQuery): Promise<Array<{ gatewayId: string; sourceId: string }>> {
    if (q.sourceIds.length === 0) return [];
    const t = this.tables.mqttOkToMqttViolations;
    const conditions = this.buildRangeConditions(q);
    const rows = await this.db
      .selectDistinct({ gatewayId: t.gatewayId, sourceId: t.sourceId })
      .from(t)
      .where(and(...conditions));
    return (rows as Array<{ gatewayId: string | null; sourceId: string }>).filter(
      (r): r is { gatewayId: string; sourceId: string } => r.gatewayId != null,
    );
  }

  /**
   * Drill-down: individual violation rows over a range, optionally filtered
   * to one gateway, newest-first by default.
   */
  async getViolations(
    q: ViolationRangeQuery & { sort?: ViolationListSort; dir?: 'asc' | 'desc' },
  ): Promise<DbMqttOkToMqttViolation[]> {
    if (q.sourceIds.length === 0) return [];
    const t = this.tables.mqttOkToMqttViolations;
    const conditions = this.buildRangeConditions(q);
    const sortColumnMap: Record<ViolationListSort, SQL> = {
      timestamp: sql`${t.timestamp}`,
      fromNode: sql`${t.fromNode}`,
      gatewayId: sql`${t.gatewayId}`,
    };
    const orderExpr = sortColumnMap[q.sort ?? 'timestamp'];
    const orderFn = q.dir === 'asc' ? asc : desc;
    const rows = await this.db
      .select()
      .from(t)
      .where(and(...conditions))
      .orderBy(orderFn(orderExpr))
      .limit(q.limit ?? DEFAULT_LIMIT)
      .offset(q.offset ?? 0);
    return this.normalizeBigInts(rows) as unknown as DbMqttOkToMqttViolation[];
  }

  /** Count of violation rows matching the same filters as {@link getViolations}, without pagination. */
  async getViolationCount(q: ViolationRangeQuery): Promise<number> {
    if (q.sourceIds.length === 0) return 0;
    const t = this.tables.mqttOkToMqttViolations;
    const conditions = this.buildRangeConditions(q);
    const res = await this.db
      .select({ count: sql<number>`COUNT(*)` })
      .from(t)
      .where(and(...conditions));
    return Number(res[0]?.count ?? 0);
  }

  /**
   * Raw row count, optionally scoped to one source. Used by retention
   * (count-based trim) and by the other single-source helpers below.
   */
  async getRowCount(query: { sourceId?: string } = {}): Promise<number> {
    const { mqttOkToMqttViolations } = this.tables;
    const whereClause = query.sourceId ? eq(mqttOkToMqttViolations.sourceId, query.sourceId) : undefined;
    const result = await this.db
      .select({ count: sql<number>`COUNT(*)` })
      .from(mqttOkToMqttViolations)
      .where(whereClause);
    return Number(result[0]?.count ?? 0);
  }

  /** Delete violation rows older than a timestamp (ms). Returns rows removed. */
  async deleteViolationsOlderThan(timestamp: number, sourceId?: string): Promise<number> {
    const { mqttOkToMqttViolations } = this.tables;
    const conditions: SQL[] = [lt(mqttOkToMqttViolations.timestamp, timestamp)];
    if (sourceId) {
      conditions.push(eq(mqttOkToMqttViolations.sourceId, sourceId));
    }
    const before = await this.getRowCount({ sourceId });
    await this.db.delete(mqttOkToMqttViolations).where(and(...conditions));
    const after = await this.getRowCount({ sourceId });
    return Math.max(0, before - after);
  }

  /**
   * Trim a source's violation history down to its newest `maxCount` rows.
   * Returns the number of rows removed.
   */
  async trimViolationsToCount(sourceId: string, maxCount: number): Promise<number> {
    if (!sourceId || maxCount <= 0) return 0;
    const { mqttOkToMqttViolations } = this.tables;
    const total = await this.getRowCount({ sourceId });
    if (total <= maxCount) return 0;

    // Find the cutoff id: keep the newest `maxCount` rows, delete the rest.
    const survivors = await this.db
      .select({ id: mqttOkToMqttViolations.id })
      .from(mqttOkToMqttViolations)
      .where(eq(mqttOkToMqttViolations.sourceId, sourceId))
      .orderBy(desc(mqttOkToMqttViolations.timestamp), desc(mqttOkToMqttViolations.id))
      .limit(maxCount);
    if (survivors.length === 0) return 0;
    const oldestKeptId = Number(survivors[survivors.length - 1].id);

    await this.db
      .delete(mqttOkToMqttViolations)
      .where(and(eq(mqttOkToMqttViolations.sourceId, sourceId), lt(mqttOkToMqttViolations.id, oldestKeptId)));
    return total - survivors.length;
  }

  /** Distinct source ids currently present in the violations table (for per-source retention trimming). */
  async getViolationSourceIds(): Promise<string[]> {
    const { mqttOkToMqttViolations } = this.tables;
    const rows = await this.db.selectDistinct({ sourceId: mqttOkToMqttViolations.sourceId }).from(mqttOkToMqttViolations);
    return rows.map((r: { sourceId: string }) => r.sourceId).filter(Boolean);
  }

  /** Delete all violation rows, optionally scoped to one source. Returns the number of rows removed. */
  async deleteAllViolations(sourceId?: string): Promise<number> {
    const { mqttOkToMqttViolations } = this.tables;
    const count = await this.getRowCount({ sourceId });
    if (sourceId) {
      await this.db.delete(mqttOkToMqttViolations).where(eq(mqttOkToMqttViolations.sourceId, sourceId));
    } else {
      await this.db.delete(mqttOkToMqttViolations);
    }
    return count;
  }
}
