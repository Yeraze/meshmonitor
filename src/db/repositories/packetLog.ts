/**
 * Packet Log Repository
 *
 * Handles packet log database operations including analytics.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, asc, and, or, inArray, sql, isNull, gte, gt, isNotNull, max, min, type SQL } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType, DbPacketLog, DbPacketCountByNode, DbPacketCountByPortnum, DbDistinctRelayNode } from '../types.js';
import { logger } from '../../utils/logger.js';
import { getPortNumName, PortNum } from '../../server/constants/meshtastic.js';
import { BROADCAST_ADDR } from '../../utils/tracerouteSegments.js';

/**
 * Per-node hop-arrival aggregate row — Mesh Issues B6 "hop horizon" evidence
 * (Phase 2 §3.2). `totalPackets` is the number of distinct `(from_node,
 * packet_id)` observations after dedup; `exhaustedPackets` is how many of
 * those had a best-observed `hopLimit` of exactly 0. Shared shape between
 * {@link PacketLogRepository.getHopArrivalCountsSince} and
 * `MqttPacketLogRepository.getHopArrivalCountsSince` — the two queries
 * differ only in table/columns and the `direction = 'rx'` clause, which
 * applies to `packet_log` only (every `mqtt_packet_log` row is already a
 * reception).
 */
export interface PacketHopArrivalRow {
  nodeNum: number;
  totalPackets: number;
  exhaustedPackets: number;
}

/**
 * Row cap for {@link PacketLogRepository.getHopArrivalCountsSince} and
 * `MqttPacketLogRepository.getHopArrivalCountsSince` (Mesh Issues Phase 2
 * §2.9's `HOP_ARRIVAL_MAX_ROWS`). Exported so callers — including the Mesh
 * Issues analysis service — can reference the same bound rather than
 * re-declaring it, and so its test can assert against it directly. `[ours]`.
 */
export const HOP_ARRIVAL_MAX_ROWS = 20_000;

/**
 * One deduped broadcast-telemetry timestamp for a node — Mesh Issues A5's
 * telemetry-cadence clause (#4964, post-epic follow-up, epic issue #4964).
 * `timestamp` is the earliest observed timestamp for the `(from_node,
 * packet_id)` pair (a retransmission/relay copy of the same originating
 * packet must not count as a second broadcast).
 */
export interface BroadcastTelemetryTimestampRow {
  nodeNum: number;
  timestamp: number;
}

/**
 * Row cap for {@link PacketLogRepository.getBroadcastTelemetryTimestamps}.
 * The caller (Mesh Issues analysis service) only ever queries the small set
 * of dedicated-router nodes (ROUTER/ROUTER_LATE), so this bound is a safety
 * net, not an expected limit. `[ours]`.
 */
export const BROADCAST_TELEMETRY_TIMESTAMPS_MAX_ROWS = 20_000;

export class PacketLogRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  // ============ PACKET LOG ============

  /**
   * Filter options for packet log queries
   */
  private buildPacketLogWhere(options: PacketLogFilterOptions): { conditions: any[]; } {
    const conditions: any[] = [];
    const { portnum, from_node, to_node, channel, encrypted, since, relay_node, transport_mechanism, sourceId, untilTs, untilId, search } = options;

    if (sourceId !== undefined) conditions.push(sql`pl.${sql.identifier('sourceId')} = ${sourceId}`);
    // Keyset cursor — mirrors ORDER BY pl.timestamp DESC, pl.id DESC so paging never
    // skips/duplicates rows that share a millisecond timestamp.
    if (untilTs !== undefined && untilId !== undefined) {
      conditions.push(sql`(pl.timestamp < ${untilTs} OR (pl.timestamp = ${untilTs} AND pl.id < ${untilId}))`);
    }
    if (portnum !== undefined) conditions.push(sql`pl.portnum = ${portnum}`);
    if (from_node !== undefined) conditions.push(sql`pl.from_node = ${from_node}`);
    if (to_node !== undefined) conditions.push(sql`pl.to_node = ${to_node}`);
    if (channel !== undefined) conditions.push(sql`pl.channel = ${channel}`);
    if (encrypted !== undefined) {
      if (this.isSQLite()) {
        conditions.push(sql`pl.encrypted = ${encrypted ? 1 : 0}`);
      } else {
        conditions.push(sql`pl.encrypted = ${encrypted}`);
      }
    }
    if (since !== undefined) conditions.push(sql`pl.timestamp >= ${since}`);
    if (relay_node === 'unknown') {
      conditions.push(sql`pl.relay_node IS NULL`);
    } else if (relay_node !== undefined) {
      conditions.push(sql`pl.relay_node = ${relay_node}`);
    }
    if (transport_mechanism !== undefined) {
      conditions.push(sql`pl.transport_mechanism = ${transport_mechanism}`);
    }
    // Free-text search across the decoded content (#4958): the human-readable
    // preview and the serialized-JSON metadata (both plain TEXT in every
    // backend). Postgres LIKE is case-sensitive, so branch to ILIKE there;
    // SQLite/MySQL LIKE are case-insensitive by default.
    //
    // The user's `%`/`_` must match literally, so they are escaped and an
    // explicit ESCAPE char is declared (SQLite has no default escape char).
    // The escape char is `~`, NOT `\`: a backslash escape clause (`ESCAPE '\'`)
    // is fine for SQLite/Postgres but breaks MySQL, where `\` escapes the
    // closing quote inside the string literal. `~` is a plain literal in all
    // three backends.
    if (search !== undefined && search !== '') {
      const escaped = search.replace(/[~%_]/g, (c: string) => `~${c}`);
      const like = `%${escaped}%`;
      // Branch the whole condition per backend rather than interpolating the
      // operator keyword, so the generated SQL is unambiguous to read.
      if (this.isPostgres()) {
        conditions.push(sql`(pl.payload_preview ILIKE ${like} ESCAPE '~' OR pl.metadata ILIKE ${like} ESCAPE '~')`);
      } else {
        conditions.push(sql`(pl.payload_preview LIKE ${like} ESCAPE '~' OR pl.metadata LIKE ${like} ESCAPE '~')`);
      }
    }

    return { conditions };
  }

  /**
   * Combine SQL conditions with AND
   */
  private combineConditions(conditions: any[]): any {
    if (conditions.length === 0) return sql`1=1`;
    return conditions.reduce((acc, cond) => sql`${acc} AND ${cond}`);
  }

  /**
   * Normalize a raw packet log row — coerce BIGINT fields to number
   */
  private normalizePacketLogRow(row: any): DbPacketLog {
    return {
      ...row,
      id: row.id != null ? Number(row.id) : row.id,
      packet_id: row.packet_id != null ? Number(row.packet_id) : row.packet_id,
      timestamp: row.timestamp != null ? Number(row.timestamp) : row.timestamp,
      from_node: row.from_node != null ? Number(row.from_node) : row.from_node,
      to_node: row.to_node != null ? Number(row.to_node) : row.to_node,
      relay_node: row.relay_node != null ? Number(row.relay_node) : row.relay_node,
      created_at: row.created_at != null ? Number(row.created_at) : row.created_at,
      // Booleans arrive as 0/1 on SQLite/MySQL and true/false on PG — coerce,
      // but preserve NULL (= unknown, pre-2.8) rather than folding it to false. (#3923)
      xeddsa_signed: row.xeddsa_signed == null ? null : Boolean(row.xeddsa_signed),
      // PostgreSQL lowercases unquoted aliases — normalize for frontend
      from_node_longName: row.from_node_longName ?? row.from_node_longname ?? null,
      to_node_longName: row.to_node_longName ?? row.to_node_longname ?? null,
    } as DbPacketLog;
  }

  /**
   * Insert a packet log entry
   */
  async insertPacketLog(packet: Omit<DbPacketLog, 'id' | 'created_at'>, sourceId?: string): Promise<number> {
    const { packetLog } = this.tables;

    try {
      const values: any = {
        packet_id: packet.packet_id ?? null,
        timestamp: packet.timestamp,
        from_node: packet.from_node,
        from_node_id: packet.from_node_id ?? null,
        to_node: packet.to_node ?? null,
        to_node_id: packet.to_node_id ?? null,
        channel: packet.channel ?? null,
        portnum: packet.portnum,
        portnum_name: packet.portnum_name ?? null,
        encrypted: packet.encrypted,
        snr: packet.snr ?? null,
        rssi: packet.rssi ?? null,
        hop_limit: packet.hop_limit ?? null,
        hop_start: packet.hop_start ?? null,
        relay_node: packet.relay_node ?? null,
        payload_size: packet.payload_size ?? null,
        want_ack: packet.want_ack ?? false,
        priority: packet.priority ?? null,
        payload_preview: packet.payload_preview ?? null,
        metadata: packet.metadata ?? null,
        direction: packet.direction ?? 'rx',
        created_at: Date.now(),
        transport_mechanism: packet.transport_mechanism ?? null,
        xeddsa_signed: packet.xeddsa_signed ?? null,
        decrypted_by: packet.decrypted_by ?? null,
        decrypted_channel_id: packet.decrypted_channel_id ?? null,
      };
      // Only write the spoof flag when set (see messages insert rationale). (#2584)
      if (packet.spoof_suspected) {
        values.spoof_suspected = true;
      }
      if (sourceId) {
        values.sourceId = sourceId;
      }

      await this.db.insert(packetLog).values(values);
      return 0;
    } catch (error) {
      logger.error(`[PacketLogRepository] Failed to insert packet log: ${error}`);
      return 0;
    }
  }

  /**
   * Enforce max count limit on packet logs (deletes oldest entries)
   */
  async enforcePacketLogMaxCount(maxCount: number): Promise<void> {
    try {
      const { packetLog } = this.tables;
      const countResult = await this.db
        .select({ count: sql<number>`count(*)` })
        .from(packetLog);
      const currentCount = Number(countResult[0]?.count ?? 0);

      if (currentCount > maxCount) {
        const deleteCount = currentCount - maxCount;
        // Two-step delete: MariaDB rejects `DELETE ... WHERE id IN (SELECT ... LIMIT ?)`
        // (ER_NOT_SUPPORTED_YET). Select oldest IDs first, then delete by ID list.
        const oldest = await this.db
          .select({ id: packetLog.id })
          .from(packetLog)
          .orderBy(asc(packetLog.timestamp))
          .limit(deleteCount);

        if (oldest.length > 0) {
          const ids = oldest.map((row: { id: number }) => row.id);
          await this.db.delete(packetLog).where(inArray(packetLog.id, ids));
        }
        logger.debug(`[PacketLogRepository] Deleted ${oldest.length} old packets to enforce max count of ${maxCount}`);
      }
    } catch (error) {
      logger.error('[PacketLogRepository] Failed to enforce packet log max count:', error);
    }
  }

  /**
   * Return the distinct set of sourceId values that appear on encrypted,
   * not-yet-server-decrypted rows of `packet_log`.
   *
   * Used by the retroactive-decrypt route as a per-source ACL pre-flight:
   * the caller must hold `messages:read` on every sourceId returned here
   * before processForChannel() is allowed to run. This is intentionally
   * conservative — it returns every source with ANY undecoded encrypted
   * packet, not just sources whose packets a specific channel PSK would
   * actually decrypt. False-positive denials are preferred over leaking
   * decrypted payloads cross-source.
   *
   * A `null` element in the returned array represents the legacy
   * pre-multi-source default-source bucket (`packet_log.sourceId IS NULL`).
   */
  async getDistinctEncryptedPacketSourceIds(): Promise<Array<string | null>> {
    const { packetLog } = this.tables;
    const encryptedTrue = this.isSQLite() ? sql`${packetLog.encrypted} = 1` : sql`${packetLog.encrypted} = true`;

    try {
      const rows = await this.db
        .selectDistinct({ sourceId: packetLog.sourceId })
        .from(packetLog)
        .where(and(encryptedTrue, isNull(packetLog.decrypted_by)));

      // Normalize empty string → null and dedupe (selectDistinct already dedupes,
      // but cross-driver behavior with NULL+empty makes a final Set safer).
      const seen = new Set<string | null>();
      for (const r of rows) {
        seen.add((r as { sourceId: string | null }).sourceId ?? null);
      }
      return Array.from(seen);
    } catch (error) {
      logger.error('[PacketLogRepository] Failed to enumerate distinct encrypted packet sourceIds:', error);
      return [];
    }
  }

  /**
   * Get packet logs with optional filters and pagination
   */
  async getPacketLogs(options: PacketLogFilterOptions & { offset?: number; limit?: number }): Promise<DbPacketLog[]> {
    const { offset = 0, limit = 100 } = options;
    const { conditions } = this.buildPacketLogWhere(options);
    const whereClause = this.combineConditions(conditions);

    try {
      const longName = this.col('longName');
      const nodeNum = this.col('nodeNum');
      const sourceIdCol = this.col('sourceId');

      // Join on both nodeNum AND sourceId so that a nodeNum present in multiple
      // sources (composite PK since migration 029) does not produce duplicate rows
      // for the same packet (#3051).
      const joinQuery = sql`
        SELECT pl.*, from_nodes.${longName} as from_node_longName, to_nodes.${longName} as to_node_longName
        FROM packet_log pl
        LEFT JOIN nodes from_nodes ON pl.from_node = from_nodes.${nodeNum} AND pl.${sourceIdCol} = from_nodes.${sourceIdCol}
        LEFT JOIN nodes to_nodes ON pl.to_node = to_nodes.${nodeNum} AND pl.${sourceIdCol} = to_nodes.${sourceIdCol}
        WHERE ${whereClause}
        ORDER BY pl.timestamp DESC, pl.id DESC LIMIT ${limit} OFFSET ${offset}
      `;

      const rows = await this.executeQuery(joinQuery);
      return (rows as any[]).map((row: any) => this.normalizePacketLogRow(row));
    } catch (error) {
      logger.error('[PacketLogRepository] Failed to get packet logs:', error);
      return [];
    }
  }

  /**
   * Get a single packet log entry by ID
   */
  async getPacketLogById(id: number): Promise<DbPacketLog | null> {
    try {
      const longName = this.col('longName');
      const nodeNum = this.col('nodeNum');
      const sourceIdCol = this.col('sourceId');

      // Join on both nodeNum AND sourceId — same fix as getPacketLogs (#3051).
      const joinQuery = sql`
        SELECT pl.*, from_nodes.${longName} as from_node_longName, to_nodes.${longName} as to_node_longName
        FROM packet_log pl
        LEFT JOIN nodes from_nodes ON pl.from_node = from_nodes.${nodeNum} AND pl.${sourceIdCol} = from_nodes.${sourceIdCol}
        LEFT JOIN nodes to_nodes ON pl.to_node = to_nodes.${nodeNum} AND pl.${sourceIdCol} = to_nodes.${sourceIdCol}
        WHERE pl.id = ${id}
      `;

      const rows = await this.executeQuery(joinQuery);
      if (!rows || rows.length === 0) return null;
      return this.normalizePacketLogRow(rows[0]);
    } catch (error) {
      logger.error('[PacketLogRepository] Failed to get packet log by id:', error);
      return null;
    }
  }

  /**
   * Get packet log count with optional filters
   */
  async getPacketLogCount(options: PacketLogFilterOptions = {}): Promise<number> {
    const { conditions } = this.buildPacketLogWhere(options);
    const whereClause = this.combineConditions(conditions);

    try {
      const rows = await this.executeQuery(
        sql`SELECT COUNT(*) as count FROM packet_log pl WHERE ${whereClause}`
      );
      return Number(rows[0]?.count ?? 0);
    } catch (error) {
      logger.error('[PacketLogRepository] Failed to get packet log count:', error);
      return 0;
    }
  }

  /**
   * Clear all packet logs, optionally scoped to a single source.
   */
  async clearPacketLogs(sourceId?: string): Promise<number> {
    try {
      const results = sourceId
        ? await this.executeRun(sql`DELETE FROM packet_log WHERE sourceId = ${sourceId}`)
        : await this.executeRun(sql`DELETE FROM packet_log`);
      const deletedCount = this.getAffectedRows(results);
      logger.debug(`[PacketLogRepository] Cleared ${deletedCount} packet log entries`);
      return deletedCount;
    } catch (error) {
      logger.error('[PacketLogRepository] Failed to clear packet logs:', error);
      throw error;
    }
  }

  /**
   * Delete packet log rows that reference a node (as from_node or to_node),
   * optionally scoped to a sourceId. Used when a single node is deleted so
   * the Packet Monitor doesn't keep showing the node's history (#2637).
   */
  async deletePacketLogsForNode(nodeNum: number, sourceId?: string): Promise<number> {
    const { packetLog } = this.tables;
    const condition = sourceId
      ? and(
          or(eq(packetLog.from_node, nodeNum), eq(packetLog.to_node, nodeNum)),
          eq(packetLog.sourceId, sourceId)
        )
      : or(eq(packetLog.from_node, nodeNum), eq(packetLog.to_node, nodeNum));

    try {
      const results = await this.executeRun(
        (this.db as any).delete(packetLog).where(condition)
      );
      const deletedCount = this.getAffectedRows(results);
      if (deletedCount > 0) {
        logger.debug(
          `[PacketLogRepository] Deleted ${deletedCount} packet log entries for node ${nodeNum}${sourceId ? `@${sourceId}` : ''}`
        );
      }
      return deletedCount;
    } catch (error) {
      logger.error('[PacketLogRepository] Failed to delete packet logs for node:', error);
      return 0;
    }
  }


  /**
   * Cleanup old packet logs based on max age
   */
  async cleanupOldPacketLogs(maxAgeHours: number): Promise<number> {
    const cutoffTimestamp = Date.now() - (maxAgeHours * 60 * 60 * 1000);

    try {
      const results = await this.executeRun(
        sql`DELETE FROM packet_log WHERE timestamp < ${cutoffTimestamp}`
      );
      const deleted = this.getAffectedRows(results);
      if (deleted > 0) {
        logger.debug(`[PacketLogRepository] Cleaned up ${deleted} packet log entries older than ${maxAgeHours} hours`);
      }
      return deleted;
    } catch (error) {
      logger.error('[PacketLogRepository] Failed to cleanup old packet logs:', error);
      return 0;
    }
  }

  /**
   * Get distinct relay_node values from packet_log for filter dropdowns.
   * relay_node is only the last byte of the node ID per the Meshtastic protobuf spec.
   * We match by (nodeNum & 0xFF) to find candidate node names.
   */
  async getDistinctRelayNodes(sourceId?: string): Promise<DbDistinctRelayNode[]> {
    const longName = this.col('longName');
    const shortName = this.col('shortName');
    const nodeNum = this.col('nodeNum');

    try {
      const conditions: any[] = [sql`relay_node IS NOT NULL`];
      if (sourceId !== undefined) conditions.push(sql`${sql.identifier('sourceId')} = ${sourceId}`);
      const whereClause = this.combineConditions(conditions);
      const distinctRows = await this.executeQuery(sql`SELECT DISTINCT relay_node FROM packet_log WHERE ${whereClause}`);
      const relayValues = (distinctRows as any[]).map((r: any) => Number(r.relay_node));

      const results: DbDistinctRelayNode[] = [];
      const hopsAway = this.col('hopsAway');
      for (const rv of relayValues) {
        // Only include nodes that could plausibly be relays:
        // direct neighbors (hopsAway <= 1) or unknown hop distance (NULL)
        const matchRows = await this.executeQuery(
          sql`SELECT ${longName}, ${shortName} FROM nodes WHERE (${nodeNum} & 255) = ${rv} AND (${hopsAway} IS NULL OR ${hopsAway} <= 1)`
        );
        results.push({
          relay_node: rv,
          matching_nodes: (matchRows as any[]).map((r: any) => ({
            longName: r.longName ?? null,
            shortName: r.shortName ?? null,
          })),
        });
      }
      return results;
    } catch (error) {
      logger.error('[PacketLogRepository] Failed to get distinct relay nodes:', error);
      return [];
    }
  }

  /**
   * Update packet log entry with decryption results (for retroactive decryption)
   */
  async updatePacketLogDecryption(
    id: number,
    decryptedBy: 'server' | 'node',
    decryptedChannelId: number | null,
    portnum: number,
    metadata: string
  ): Promise<void> {
    if (this.isSQLite()) {
      // SQLite uses 0 for false
      await this.executeRun(sql`
        UPDATE packet_log
        SET decrypted_by = ${decryptedBy},
            decrypted_channel_id = ${decryptedChannelId},
            portnum = ${portnum},
            encrypted = 0,
            metadata = ${metadata}
        WHERE id = ${id}
      `);
    } else {
      await this.executeRun(sql`
        UPDATE packet_log
        SET decrypted_by = ${decryptedBy},
            decrypted_channel_id = ${decryptedChannelId},
            portnum = ${portnum},
            encrypted = false,
            metadata = ${metadata}
        WHERE id = ${id}
      `);
    }
  }




  /**
   * Get packet counts per from_node since a given timestamp, excluding internal
   * traffic (packets where both ends are the local node). Used for spam
   * detection / last-hour broadcaster stats.
   */
  async getPacketCountsPerNodeSince(options: {
    since: number;
    localNodeNum: number | null;
    sourceId?: string;
  }): Promise<Array<{ nodeNum: number; packetCount: number }>> {
    const { since, localNodeNum, sourceId } = options;
    const ln = localNodeNum ?? -1;
    try {
      const conditions: any[] = [
        sql`timestamp >= ${since}`,
        sql`NOT (from_node = ${ln} AND to_node = ${ln})`,
      ];
      if (sourceId !== undefined) conditions.push(sql`${sql.identifier('sourceId')} = ${sourceId}`);
      const whereClause = this.combineConditions(conditions);

      const rows = await this.executeQuery(sql`
        SELECT from_node as "nodeNum", COUNT(*) as "packetCount"
        FROM packet_log
        WHERE ${whereClause}
        GROUP BY from_node
      `);

      return (rows as any[]).map((r: any) => ({
        nodeNum: Number(r.nodeNum ?? r.nodenum),
        packetCount: Number(r.packetCount ?? r.packetcount),
      }));
    } catch (error) {
      logger.error('[PacketLogRepository] Failed to get packet counts per node since:', error);
      return [];
    }
  }

  /**
   * Count packets logged in the last `sinceMs` milliseconds, grouped by
   * protocol (portnum). Powers the traffic-mix gauge on the v1 metrics
   * endpoint. `portnum_name` rides along so consumers get a display name
   * without needing the protobuf enum; rows logged before decode (or for
   * ports the decoder does not name) have a NULL name and the caller is
   * expected to fall back to the number.
   */
  async getPacketCountsByPortSince(
    sourceId: string,
    sinceMs: number
  ): Promise<Array<{ portnum: number | null; portnumName: string | null; packetCount: number }>> {
    const cutoff = Date.now() - sinceMs;
    try {
      const conditions = [
        sql`timestamp >= ${cutoff}`,
        sql`${sql.identifier('sourceId')} = ${sourceId}`,
      ];
      const whereClause = this.combineConditions(conditions);

      const rows = await this.executeQuery(sql`
        SELECT portnum, portnum_name as "portnumName", COUNT(*) as "packetCount"
        FROM packet_log
        WHERE ${whereClause}
        GROUP BY portnum, portnum_name
      `);

      type PortCountRow = {
        portnum?: number | string | null;
        portnumName?: string | null;
        portnumname?: string | null;
        packetCount?: number | string;
        packetcount?: number | string;
      };
      return (rows as PortCountRow[]).map((r) => ({
        portnum: r.portnum === null || r.portnum === undefined ? null : Number(r.portnum),
        portnumName: r.portnumName ?? r.portnumname ?? null,
        packetCount: Number(r.packetCount ?? r.packetcount),
      }));
    } catch (error) {
      logger.error('[PacketLogRepository] Failed to get packet counts by port since:', error);
      return [];
    }
  }

  /**
   * Get top N broadcasters by packet count since a given timestamp, excluding
   * internal traffic (packets where both ends are the local node).
   */
  async getTopBroadcastersSince(options: {
    since: number;
    limit: number;
    localNodeNum: number | null;
    sourceId?: string;
  }): Promise<Array<{ nodeNum: number; shortName: string | null; longName: string | null; packetCount: number }>> {
    const { since, limit, localNodeNum, sourceId } = options;
    const ln = localNodeNum ?? -1;
    try {
      const longName = this.col('longName');
      const shortName = this.col('shortName');
      const nodeNum = this.col('nodeNum');

      const conditions: any[] = [
        sql`p.timestamp >= ${since}`,
        sql`NOT (p.from_node = ${ln} AND p.to_node = ${ln})`,
      ];
      if (sourceId !== undefined) conditions.push(sql`p.${sql.identifier('sourceId')} = ${sourceId}`);
      const whereClause = this.combineConditions(conditions);

      const rows = await this.executeQuery(sql`
        SELECT p.from_node as "nodeNum", n.${shortName} as "shortName", n.${longName} as "longName", COUNT(*) as "packetCount"
        FROM packet_log p
        LEFT JOIN nodes n ON p.from_node = n.${nodeNum}
        WHERE ${whereClause}
        GROUP BY p.from_node, n.${shortName}, n.${longName}
        ORDER BY "packetCount" DESC
        LIMIT ${limit}
      `);

      return (rows as any[]).map((r: any) => ({
        nodeNum: Number(r.nodeNum ?? r.nodenum),
        shortName: r.shortName ?? r.shortname ?? null,
        longName: r.longName ?? r.longname ?? null,
        packetCount: Number(r.packetCount ?? r.packetcount),
      }));
    } catch (error) {
      logger.error('[PacketLogRepository] Failed to get top broadcasters since:', error);
      return [];
    }
  }

  /**
   * Get packet counts grouped by from_node (for distribution charts).
   * Returns top N nodes by packet count.
   */
  async getPacketCountsByNode(options?: { since?: number; limit?: number; portnum?: number; sourceId?: string }): Promise<DbPacketCountByNode[]> {
    const { since, limit = 10, portnum, sourceId } = options || {};

    try {
      const conditions: any[] = [];
      if (sourceId !== undefined) conditions.push(sql`pl.${sql.identifier('sourceId')} = ${sourceId}`);
      if (since !== undefined) conditions.push(sql`pl.timestamp >= ${since}`);
      if (portnum !== undefined) conditions.push(sql`pl.portnum = ${portnum}`);
      const whereClause = conditions.length > 0 ? this.combineConditions(conditions) : sql`1=1`;

      const longName = this.col('longName');
      const nodeNum = this.col('nodeNum');

      // Aggregate on packet_log alone — joining `nodes` here would multiply
      // COUNT(*) by the number of sources because `nodes` has composite PK
      // (nodeNum, sourceId) since migration 029, so the same nodeNum appears
      // once per source (#2794). Resolve longName via a scalar subquery that
      // prefers the requested sourceId and otherwise picks one deterministically.
      const nameConditions: any[] = [sql`n.${nodeNum} = agg.from_node`];
      if (sourceId !== undefined) {
        nameConditions.push(sql`n.${sql.identifier('sourceId')} = ${sourceId}`);
      }
      const nameWhere = this.combineConditions(nameConditions);

      const query = sql`
        SELECT agg.from_node, agg.from_node_id,
          (SELECT n.${longName} FROM nodes n WHERE ${nameWhere} LIMIT 1) as from_node_longName,
          agg.count
        FROM (
          SELECT pl.from_node, pl.from_node_id, COUNT(*) as count
          FROM packet_log pl
          WHERE ${whereClause}
          GROUP BY pl.from_node, pl.from_node_id
          ORDER BY COUNT(*) DESC
          LIMIT ${limit}
        ) agg
      `;

      const rows = await this.executeQuery(query);
      return (rows as any[]).map((row: any) => ({
        from_node: Number(row.from_node),
        from_node_id: row.from_node_id,
        from_node_longName: row.from_node_longName ?? row.from_node_longname ?? null,
        count: Number(row.count),
      }));
    } catch (error) {
      logger.error('[PacketLogRepository] Failed to get packet counts by node:', error);
      return [];
    }
  }

  /**
   * Get packet counts grouped by portnum (for distribution charts).
   * Includes port name from meshtastic constants.
   */
  async getPacketCountsByPortnum(options?: { since?: number; from_node?: number; sourceId?: string }): Promise<DbPacketCountByPortnum[]> {
    const { since, from_node, sourceId } = options || {};

    try {
      const conditions: any[] = [];
      if (sourceId !== undefined) conditions.push(sql`${sql.identifier('sourceId')} = ${sourceId}`);
      if (since !== undefined) conditions.push(sql`timestamp >= ${since}`);
      if (from_node !== undefined) conditions.push(sql`from_node = ${from_node}`);
      const whereClause = conditions.length > 0 ? this.combineConditions(conditions) : sql`1=1`;

      const rows = await this.executeQuery(sql`
        SELECT portnum, COUNT(*) as count
        FROM packet_log
        WHERE ${whereClause}
        GROUP BY portnum
        ORDER BY count DESC
      `);

      return (rows as any[]).map((row: any) => ({
        portnum: Number(row.portnum),
        portnum_name: getPortNumName(Number(row.portnum)),
        count: Number(row.count),
      }));
    } catch (error) {
      logger.error('[PacketLogRepository] Failed to get packet counts by portnum:', error);
      return [];
    }
  }

  /**
   * Per-node hop-arrival stats since `since` — Mesh Issues B6 "hop horizon"
   * evidence (Phase 2 §3.2). A two-level aggregate:
   *
   * 1. Inner (deduplication): group by `(from_node, packet_id)` and take
   *    `MAX(hop_limit)`. The same originating packet can be logged more than
   *    once (retransmission/relay copies), and the epic's dedup rule takes
   *    the maximum observed hopLimit — a packet that still had life at ANY
   *    vantage does not count as exhausted (the conservative tie-break,
   *    D9 in MESH_ISSUES_P2_SPEC.md — keeps B6 from firing on one unlucky
   *    capture).
   * 2. Outer: per node, count total deduped packets and how many of those
   *    had a best-observed `hopLimit` of exactly 0.
   *
   * `direction = 'rx'` is required here (and only here — the MQTT sibling
   * query has no such column, because every `mqtt_packet_log` row is already
   * a reception): this is our own RF vantage's log, and a row we ourselves
   * transmitted is not an "arrival". `hop_start > 0` excludes packets whose
   * hop budget is unknown — `hop_start = 0` is the unknown sentinel, never a
   * genuine reading.
   *
   * `sourceIds` is optional here (unlike the MQTT variant, where it is
   * required) — omitting it runs the aggregate unscoped. When provided and
   * empty, returns `[]` immediately rather than issuing an unbounded scan.
   *
   * Results are capped at `limit` (default {@link HOP_ARRIVAL_MAX_ROWS}),
   * ordered by `totalPackets` descending so a cap that bites keeps the
   * best-evidenced nodes.
   */
  async getHopArrivalCountsSince(q: {
    since: number;
    sourceIds?: string[];
    limit?: number;
  }): Promise<PacketHopArrivalRow[]> {
    if (q.sourceIds && q.sourceIds.length === 0) return [];

    const { packetLog } = this.tables;
    const conditions: SQL[] = [
      gte(packetLog.timestamp, q.since),
      eq(packetLog.direction, 'rx'),
      isNotNull(packetLog.packet_id),
      isNotNull(packetLog.hop_limit),
      isNotNull(packetLog.hop_start),
      gt(packetLog.hop_start, 0),
    ];
    if (q.sourceIds) {
      conditions.push(inArray(packetLog.sourceId, q.sourceIds));
    }

    try {
      const deduped = this.db
        .select({
          nodeNum: packetLog.from_node,
          pid: packetLog.packet_id,
          maxHopLimit: max(packetLog.hop_limit).as('maxHopLimit'),
        })
        .from(packetLog)
        .where(and(...conditions))
        .groupBy(packetLog.from_node, packetLog.packet_id)
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

      // Explicit Number() coercion, not just normalizeBigInts: PostgreSQL's
      // driver returns BIGINT-derived aggregates (COUNT/SUM) as strings by
      // default, which normalizeBigInts (typeof 'bigint' only) would not
      // catch — the same reason getGroupedPacketCount coerces explicitly.
      return (rows as Array<{ nodeNum: unknown; totalPackets: unknown; exhaustedPackets: unknown }>).map((r) => ({
        nodeNum: Number(r.nodeNum),
        totalPackets: Number(r.totalPackets),
        exhaustedPackets: Number(r.exhaustedPackets),
      }));
    } catch (error) {
      logger.error('[PacketLogRepository] Failed to get hop arrival counts:', error);
      return [];
    }
  }

  /**
   * Deduped broadcast TELEMETRY_APP receive timestamps for a bounded set of
   * nodes since `since` — Mesh Issues A5's telemetry-cadence clause
   * (#4964, post-epic follow-up). Only rows with `to_node = BROADCAST_ADDR`
   * count (a directed/solicited reply is a DM, not a broadcast); `direction
   * = 'rx'` is required for the same reason as
   * {@link getHopArrivalCountsSince} — this is our own RF vantage's log, and
   * a row we transmitted ourselves is not a reception.
   *
   * Deduped by `(from_node, packet_id)`, taking the earliest observed
   * timestamp — the same originating packet can be logged more than once
   * (retransmission/relay copies) and must count as one broadcast, not one
   * per copy. Results are ordered `(nodeNum, timestamp)` ascending, so
   * timestamps come back ascending WITHIN each node's own subsequence, and
   * capped at `limit` (default {@link BROADCAST_TELEMETRY_TIMESTAMPS_MAX_ROWS}).
   *
   * Returns `[]` immediately for an empty `nodeNums` (mirrors the empty
   * `sourceIds` short-circuit above) rather than issuing an unbounded scan.
   */
  async getBroadcastTelemetryTimestamps(q: {
    nodeNums: number[];
    since: number;
    limit?: number;
  }): Promise<BroadcastTelemetryTimestampRow[]> {
    if (q.nodeNums.length === 0) return [];

    const { packetLog } = this.tables;
    const conditions: SQL[] = [
      inArray(packetLog.from_node, q.nodeNums),
      eq(packetLog.to_node, BROADCAST_ADDR),
      eq(packetLog.portnum, PortNum.TELEMETRY_APP),
      eq(packetLog.direction, 'rx'),
      gte(packetLog.timestamp, q.since),
      isNotNull(packetLog.packet_id),
    ];

    try {
      const deduped = this.db
        .select({
          nodeNum: packetLog.from_node,
          pid: packetLog.packet_id,
          timestamp: min(packetLog.timestamp).as('timestamp'),
        })
        .from(packetLog)
        .where(and(...conditions))
        .groupBy(packetLog.from_node, packetLog.packet_id)
        .as('deduped');

      const rows = await this.db
        .select({
          nodeNum: deduped.nodeNum,
          timestamp: deduped.timestamp,
        })
        .from(deduped)
        .orderBy(asc(deduped.nodeNum), asc(deduped.timestamp))
        .limit(q.limit ?? BROADCAST_TELEMETRY_TIMESTAMPS_MAX_ROWS);

      return (rows as Array<{ nodeNum: unknown; timestamp: unknown }>).map((r) => ({
        nodeNum: Number(r.nodeNum),
        timestamp: Number(r.timestamp),
      }));
    } catch (error) {
      logger.error('[PacketLogRepository] Failed to get broadcast telemetry timestamps:', error);
      return [];
    }
  }
}

/**
 * Filter options for packet log queries
 */
export interface PacketLogFilterOptions {
  portnum?: number;
  from_node?: number;
  to_node?: number;
  channel?: number;
  encrypted?: boolean;
  since?: number;
  relay_node?: number | 'unknown';
  transport_mechanism?: number;
  sourceId?: string;
  /** Free-text substring match across payload_preview + metadata (#4958). */
  search?: string;
  /**
   * Keyset (composite) cursor for descending pagination. When both are provided,
   * only rows strictly "older" than (untilTs, untilId) in the
   * `timestamp DESC, id DESC` ordering are returned:
   *   timestamp < untilTs OR (timestamp = untilTs AND id < untilId)
   * This mirrors the ORDER BY in getPacketLogs so paging across rows that share a
   * millisecond timestamp (e.g. one mesh packet logged by multiple sources) never
   * skips or duplicates rows. Used by the unified packet monitor.
   */
  untilTs?: number;
  untilId?: number;
}
