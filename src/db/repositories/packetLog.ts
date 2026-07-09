/**
 * Packet Log Repository
 *
 * Handles packet log database operations including analytics.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, asc, and, or, inArray, sql, isNull } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType, DbPacketLog, DbPacketCountByNode, DbPacketCountByPortnum, DbDistinctRelayNode } from '../types.js';
import { logger } from '../../utils/logger.js';
import { getPortNumName } from '../../server/constants/meshtastic.js';

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
    const { portnum, from_node, to_node, channel, encrypted, since, relay_node, transport_mechanism, sourceId, untilTs, untilId } = options;

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
   * Synchronously delete packet log rows for a node (SQLite only).
   */
  deletePacketLogsForNodeSync(nodeNum: number, sourceId?: string): number {
    const db = this.getSqliteDb();
    const { packetLog } = this.tables;
    const condition = sourceId
      ? and(
          or(eq(packetLog.from_node, nodeNum), eq(packetLog.to_node, nodeNum)),
          eq(packetLog.sourceId, sourceId)
        )
      : or(eq(packetLog.from_node, nodeNum), eq(packetLog.to_node, nodeNum));
    const result = (db as any).delete(packetLog).where(condition).run() as any;
    const changes = Number(result?.changes ?? 0);
    if (changes > 0) {
      logger.debug(
        `[PacketLogRepository] Deleted ${changes} packet log entries for node ${nodeNum}${sourceId ? `@${sourceId}` : ''} (sync)`
      );
    }
    return changes;
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
   * Synchronously clear all packet log rows (SQLite only).
   * Returns number of rows deleted.
   */
  clearPacketLogsSync(sourceId?: string): number {
    const db = this.getSqliteDb();
    const result = (sourceId
      ? db.run(sql`DELETE FROM packet_log WHERE sourceId = ${sourceId}`)
      : db.run(sql`DELETE FROM packet_log`)) as any;
    const changes = Number(result?.changes ?? 0);
    logger.debug(`[PacketLogRepository] Cleared ${changes} packet log entries (sync)`);
    return changes;
  }

  /**
   * Synchronously cleanup packet logs older than cutoffTimestamp (SQLite only).
   * Returns number of rows deleted.
   */
  cleanupOldPacketLogsSync(cutoffTimestamp: number): number {
    const db = this.getSqliteDb();
    const result = db.run(sql`DELETE FROM packet_log WHERE timestamp < ${cutoffTimestamp}`) as any;
    return Number(result?.changes ?? 0);
  }

  /**
   * Synchronously get packet counts per from_node since a given timestamp,
   * excluding internal traffic. (SQLite only.)
   */
  getPacketCountsPerNodeSinceSync(options: {
    since: number;
    localNodeNum: number | null;
  }): Array<{ nodeNum: number; packetCount: number }> {
    const db = this.getSqliteDb();
    const { since, localNodeNum } = options;
    const ln = localNodeNum ?? -1;
    const rows = db.all(sql`
      SELECT from_node as nodeNum, COUNT(*) as packetCount
      FROM packet_log
      WHERE timestamp >= ${since}
        AND NOT (from_node = ${ln} AND to_node = ${ln})
      GROUP BY from_node
    `) as any[];
    return rows.map((r: any) => ({
      nodeNum: Number(r.nodeNum),
      packetCount: Number(r.packetCount),
    }));
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
