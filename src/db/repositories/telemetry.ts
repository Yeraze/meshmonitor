/**
 * Telemetry Repository
 *
 * Handles all telemetry-related database operations.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, lt, gte, and, desc, inArray, or, not, SQL, count, sql } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType, DbTelemetry } from '../types.js';

/**
 * Favorite telemetry entry: (nodeId, telemetryType) pair that should be
 * retained longer than regular telemetry during purge operations.
 */
export interface TelemetryFavorite {
  nodeId: string;
  telemetryType: string;
}

/**
 * Normalize a telemetry row from a sync SQLite Drizzle query to the legacy
 * DbTelemetry shape expected by facade callers: converts `null` fields back
 * to `undefined` and returns the same object reference when possible.
 */
function normalizeSyncTelemetryRow(row: any): any {
  if (row == null) return row;
  // Convert known nullable columns from null to undefined to match DbTelemetry
  const nullable = ['unit', 'packetTimestamp', 'packetId', 'channel', 'precisionBits', 'gpsAccuracy', 'sourceId'] as const;
  for (const k of nullable) {
    if (row[k] === null) row[k] = undefined;
  }
  return row;
}

/**
 * Repository for telemetry operations
 */
export class TelemetryRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  /**
   * Insert a telemetry record.
   *
   * Uses insertIgnore so that rows colliding on the migration 032 unique
   * index (sourceId, nodeNum, packetId, telemetryType) WHERE packetId IS NOT
   * NULL are silently dropped. Same Meshtastic packet re-broadcast through
   * multiple mesh routers must not produce duplicate rows.
   *
   * Returns true if a new row was inserted, false if it was a duplicate that
   * got suppressed by the constraint. Rows with NULL packetId (legacy or
   * synthesized telemetry) bypass the constraint and always insert.
   */
  async insertTelemetry(telemetryData: DbTelemetry, sourceId?: string): Promise<boolean> {
    const { telemetry } = this.tables;
    const values: any = {
      nodeId: telemetryData.nodeId,
      nodeNum: telemetryData.nodeNum,
      telemetryType: telemetryData.telemetryType,
      timestamp: telemetryData.timestamp,
      value: telemetryData.value,
      unit: telemetryData.unit ?? null,
      createdAt: telemetryData.createdAt,
      packetTimestamp: telemetryData.packetTimestamp ?? null,
      packetId: telemetryData.packetId ?? null,
      channel: telemetryData.channel ?? null,
      precisionBits: telemetryData.precisionBits ?? null,
      gpsAccuracy: telemetryData.gpsAccuracy ?? null,
    };
    if (sourceId) {
      values.sourceId = sourceId;
    }

    const result = await this.insertIgnore(telemetry, values);
    return this.getAffectedRows(result) > 0;
  }

  /**
   * Insert multiple telemetry rows in a single statement. Reduces pool
   * acquires during bursts like NodeInfo (position + device metrics + SNR
   * can be ≥10 rows per packet). Uses multi-row VALUES with
   * onConflictDoNothing on SQLite/PostgreSQL; MySQL falls back to serial
   * inserts since our Drizzle version lacks multi-row ignore.
   */
  async insertTelemetryBatch(
    rows: DbTelemetry[],
    sourceId?: string
  ): Promise<number> {
    if (rows.length === 0) return 0;

    const { telemetry } = this.tables;
    const valuesArray = rows.map((r) => {
      const v: any = {
        nodeId: r.nodeId,
        nodeNum: r.nodeNum,
        telemetryType: r.telemetryType,
        timestamp: r.timestamp,
        value: r.value,
        unit: r.unit ?? null,
        createdAt: r.createdAt,
        packetTimestamp: r.packetTimestamp ?? null,
        packetId: r.packetId ?? null,
        channel: r.channel ?? null,
        precisionBits: r.precisionBits ?? null,
        gpsAccuracy: r.gpsAccuracy ?? null,
      };
      if (sourceId) v.sourceId = sourceId;
      return v;
    });

    if (this.isMySQL()) {
      let inserted = 0;
      for (const v of valuesArray) {
        try {
          const r = await this.db.insert(telemetry).values(v);
          inserted += this.getAffectedRows(r);
        } catch {
          // Duplicate key — swallow, matches single insertIgnore semantics
        }
      }
      return inserted;
    }

    const result = await (this.db as any)
      .insert(telemetry)
      .values(valuesArray)
      .onConflictDoNothing();
    return this.getAffectedRows(result);
  }

  /**
   * Get telemetry count
   */
  async getTelemetryCount(): Promise<number> {
    const { telemetry } = this.tables;
    const result = await this.db.select({ count: count() }).from(telemetry);
    return Number(result[0].count);
  }

  /**
   * Get telemetry count by node with optional filters
   */
  async getTelemetryCountByNode(
    nodeId: string,
    sinceTimestamp?: number,
    beforeTimestamp?: number,
    telemetryType?: string,
    sourceId?: string
  ): Promise<number> {
    const { telemetry } = this.tables;
    let conditions = [eq(telemetry.nodeId, nodeId)];

    const sourceScope = this.withSourceScope(telemetry, sourceId);
    if (sourceScope) conditions.push(sourceScope);

    if (sinceTimestamp !== undefined) {
      conditions.push(gte(telemetry.timestamp, sinceTimestamp));
    }
    if (beforeTimestamp !== undefined) {
      conditions.push(lt(telemetry.timestamp, beforeTimestamp));
    }
    if (telemetryType !== undefined) {
      conditions.push(eq(telemetry.telemetryType, telemetryType));
    }

    const result = await this.db
      .select()
      .from(telemetry)
      .where(and(...conditions));

    return result.length;
  }

  /**
   * Get telemetry by node with optional filters
   */
  async getTelemetryByNode(
    nodeId: string,
    limit: number = 100,
    sinceTimestamp?: number,
    beforeTimestamp?: number,
    offset: number = 0,
    telemetryType?: string,
    sourceId?: string
  ): Promise<DbTelemetry[]> {
    const { telemetry } = this.tables;
    let conditions = [eq(telemetry.nodeId, nodeId)];

    const sourceScope = this.withSourceScope(telemetry, sourceId);
    if (sourceScope) conditions.push(sourceScope);

    if (sinceTimestamp !== undefined) {
      conditions.push(gte(telemetry.timestamp, sinceTimestamp));
    }
    if (beforeTimestamp !== undefined) {
      conditions.push(lt(telemetry.timestamp, beforeTimestamp));
    }
    if (telemetryType !== undefined) {
      conditions.push(eq(telemetry.telemetryType, telemetryType));
    }

    const result = await this.db
      .select()
      .from(telemetry)
      .where(and(...conditions))
      .orderBy(desc(telemetry.timestamp))
      .limit(limit)
      .offset(offset);

    return this.normalizeBigInts(result) as DbTelemetry[];
  }

  /**
   * Get position telemetry (latitude, longitude, altitude, groundSpeed, groundTrack) for a node
   */
  async getPositionTelemetryByNode(
    nodeId: string,
    limit: number = 1500,
    sinceTimestamp?: number,
    sourceId?: string
  ): Promise<DbTelemetry[]> {
    const positionTypes = ['latitude', 'longitude', 'altitude', 'ground_speed', 'ground_track'];
    const { telemetry } = this.tables;

    let conditions = [
      eq(telemetry.nodeId, nodeId),
      inArray(telemetry.telemetryType, positionTypes),
    ];

    const sourceScope = this.withSourceScope(telemetry, sourceId);
    if (sourceScope) conditions.push(sourceScope);

    if (sinceTimestamp !== undefined) {
      conditions.push(gte(telemetry.timestamp, sinceTimestamp));
    }

    const result = await this.db
      .select()
      .from(telemetry)
      .where(and(...conditions))
      .orderBy(desc(telemetry.timestamp))
      .limit(limit);

    return this.normalizeBigInts(result) as DbTelemetry[];
  }

  /**
   * Get telemetry by type
   */
  async getTelemetryByType(telemetryType: string, limit: number = 100): Promise<DbTelemetry[]> {
    const { telemetry } = this.tables;
    const result = await this.db
      .select()
      .from(telemetry)
      .where(eq(telemetry.telemetryType, telemetryType))
      .orderBy(desc(telemetry.timestamp))
      .limit(limit);

    return this.normalizeBigInts(result) as DbTelemetry[];
  }

  /**
   * Get all telemetry rows of any of the given types since a timestamp,
   * optionally restricted to a set of sourceIds. Used by cross-node analytics
   * (e.g. solar pattern detection) where we need to scan multiple metrics
   * across many nodes within a lookback window.
   */
  async getTelemetryByTypesSince(
    telemetryTypes: string[],
    sinceTimestamp: number,
    sourceIds?: string[],
  ): Promise<DbTelemetry[]> {
    if (telemetryTypes.length === 0) return [];
    const { telemetry } = this.tables;
    const conditions: SQL[] = [
      inArray(telemetry.telemetryType, telemetryTypes),
      gte(telemetry.timestamp, sinceTimestamp),
    ];
    if (sourceIds && sourceIds.length > 0) {
      conditions.push(inArray(telemetry.sourceId, sourceIds));
    }
    const result = await this.db
      .select()
      .from(telemetry)
      .where(and(...conditions))
      .orderBy(telemetry.timestamp);
    return this.normalizeBigInts(result) as DbTelemetry[];
  }

  /**
   * Get latest telemetry for each type for a node
   */
  async getLatestTelemetryByNode(nodeId: string): Promise<DbTelemetry[]> {
    // Get all distinct types for this node, then get latest of each
    const types = await this.getNodeTelemetryTypes(nodeId);
    const results: DbTelemetry[] = [];

    for (const type of types) {
      const latest = await this.getLatestTelemetryForType(nodeId, type);
      if (latest) {
        results.push(latest);
      }
    }

    return results;
  }

  /**
   * Get latest telemetry for a specific type for a node
   */
  async getLatestTelemetryForType(nodeId: string, telemetryType: string): Promise<DbTelemetry | null> {
    const { telemetry } = this.tables;
    const result = await this.db
      .select()
      .from(telemetry)
      .where(
        and(
          eq(telemetry.nodeId, nodeId),
          eq(telemetry.telemetryType, telemetryType)
        )
      )
      .orderBy(desc(telemetry.timestamp))
      .limit(1);

    if (result.length === 0) return null;
    return this.normalizeBigInts(result[0]) as DbTelemetry;
  }

  /**
   * Get latest telemetry value for a given type across all nodes in a single query.
   * Returns a Map of nodeId -> value.
   *
   * When `sourceId` is provided, results are scoped to that source — required for
   * correctness in multi-source deployments, where the same nodeId can have
   * telemetry from multiple sources (issue #2831).
   *
   * Keeps branching: PostgreSQL uses DISTINCT ON, SQLite/MySQL use subquery with MAX.
   * Different raw SQL and result shapes per dialect.
   */
  async getLatestTelemetryValueForAllNodes(
    telemetryType: string,
    sourceId?: string,
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const innerSourceFilter = sourceId ? sql`AND sourceId = ${sourceId}` : sql``;
      const outerSourceFilter = sourceId ? sql`AND t.sourceId = ${sourceId}` : sql``;
      const rows = await db.all<{ nodeId: string; value: number }>(
        sql`SELECT t.nodeId, t.value FROM telemetry t
            INNER JOIN (
              SELECT nodeId, MAX(timestamp) as maxTs
              FROM telemetry WHERE telemetryType = ${telemetryType} ${innerSourceFilter}
              GROUP BY nodeId
            ) latest ON t.nodeId = latest.nodeId AND t.timestamp = latest.maxTs
            WHERE t.telemetryType = ${telemetryType} ${outerSourceFilter}`
      );
      for (const row of rows) {
        result.set(row.nodeId, Number(row.value));
      }
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const innerSourceFilter = sourceId ? sql`AND sourceId = ${sourceId}` : sql``;
      const outerSourceFilter = sourceId ? sql`AND t.sourceId = ${sourceId}` : sql``;
      const [rows] = await (db as any).execute(
        sql`SELECT t.nodeId, t.value FROM telemetry t
            INNER JOIN (
              SELECT nodeId, MAX(timestamp) as maxTs
              FROM telemetry WHERE telemetryType = ${telemetryType} ${innerSourceFilter}
              GROUP BY nodeId
            ) latest ON t.nodeId = latest.nodeId AND t.timestamp = latest.maxTs
            WHERE t.telemetryType = ${telemetryType} ${outerSourceFilter}`
      );
      for (const row of rows as any[]) {
        result.set(row.nodeId, Number(row.value));
      }
    } else {
      const db = this.getPostgresDb();
      const sourceFilter = sourceId
        ? sql`AND ${this.col('sourceId')} = ${sourceId}`
        : sql``;
      const rows = await db.execute(
        sql`SELECT DISTINCT ON (${this.col('nodeId')}) ${this.col('nodeId')}, value
            FROM telemetry
            WHERE ${this.col('telemetryType')} = ${telemetryType} ${sourceFilter}
            ORDER BY ${this.col('nodeId')}, timestamp DESC`
      );
      for (const row of rows.rows) {
        result.set(row.nodeId as string, Number(row.value));
      }
    }

    return result;
  }

  /**
   * Get all telemetry types for a node
   */
  async getNodeTelemetryTypes(nodeId: string): Promise<string[]> {
    const { telemetry } = this.tables;
    const result = await this.db
      .selectDistinct({ type: telemetry.telemetryType })
      .from(telemetry)
      .where(eq(telemetry.nodeId, nodeId));

    return result.map((r: any) => r.type);
  }

  /**
   * Delete telemetry by node and type.
   * Keeps branching: MySQL doesn't support .returning().
   */
  async deleteTelemetryByNodeAndType(nodeId: string, telemetryType: string): Promise<boolean> {
    const { telemetry } = this.tables;
    const condition = and(eq(telemetry.nodeId, nodeId), eq(telemetry.telemetryType, telemetryType));

    if (this.isMySQL()) {
      const countResult = await this.db
        .select({ cnt: count() })
        .from(telemetry)
        .where(condition);
      if (Number(countResult[0]?.cnt ?? 0) === 0) return false;
      await this.db.delete(telemetry).where(condition);
      return true;
    } else {
      const deleted = await (this.db as any)
        .delete(telemetry)
        .where(condition)
        .returning({ id: telemetry.id });
      return deleted.length > 0;
    }
  }

  /**
   * Purge telemetry for a node, optionally scoped to a source.
   * Delegates to deleteTelemetryByNode.
   */
  async purgeNodeTelemetry(nodeNum: number, sourceId?: string): Promise<number> {
    return this.deleteTelemetryByNode(nodeNum, sourceId);
  }

  /**
   * Purge position history for a specific node.
   * Deletes only position-related telemetry types (latitude, longitude, altitude, etc.)
   * Keeps branching: MySQL doesn't support .returning().
   */
  async purgePositionHistory(nodeNum: number, sourceId?: string): Promise<number> {
    const positionTypes = [
      'latitude', 'longitude', 'altitude',
      'ground_speed', 'ground_track',
      'estimated_latitude', 'estimated_longitude',
    ];
    const { telemetry } = this.tables;
    const conditions = [
      eq(telemetry.nodeNum, nodeNum),
      inArray(telemetry.telemetryType, positionTypes),
    ];
    if (sourceId) {
      conditions.push(eq(telemetry.sourceId, sourceId));
    }
    const condition = and(...conditions);

    if (this.isMySQL()) {
      const countResult = await this.db
        .select({ cnt: count() })
        .from(telemetry)
        .where(condition);
      const cnt = Number(countResult[0]?.cnt ?? 0);
      await this.db.delete(telemetry).where(condition);
      return cnt;
    } else {
      const deleted = await (this.db as any)
        .delete(telemetry)
        .where(condition)
        .returning({ id: telemetry.id });
      return deleted.length;
    }
  }

  /**
   * Cleanup old telemetry data.
   * Delegates to deleteOldTelemetry with calculated cutoff timestamp.
   */
  async cleanupOldTelemetry(days: number = 30): Promise<number> {
    const cutoff = this.now() - (days * 24 * 60 * 60 * 1000);
    return this.deleteOldTelemetry(cutoff);
  }

  /**
   * Delete telemetry older than a given timestamp.
   * Keeps branching: MySQL doesn't support .returning().
   */
  async deleteOldTelemetry(cutoffTimestamp: number): Promise<number> {
    const { telemetry } = this.tables;

    if (this.isMySQL()) {
      const countResult = await this.db
        .select({ cnt: count() })
        .from(telemetry)
        .where(lt(telemetry.timestamp, cutoffTimestamp));
      const cnt = Number(countResult[0]?.cnt ?? 0);
      await this.db.delete(telemetry).where(lt(telemetry.timestamp, cutoffTimestamp));
      return cnt;
    } else {
      const deleted = await (this.db as any)
        .delete(telemetry)
        .where(lt(telemetry.timestamp, cutoffTimestamp))
        .returning({ id: telemetry.id });
      return deleted.length;
    }
  }

  /**
   * Build a SQL condition that matches any of the favorited (nodeId, telemetryType) pairs.
   * Returns null if favorites array is empty.
   */
  protected buildFavoritesCondition(
    favorites: Array<{ nodeId: string; telemetryType: string }>
  ): SQL | null {
    if (favorites.length === 0) return null;
    const { telemetry } = this.tables;

    const conditions = favorites.map(f =>
      and(eq(telemetry.nodeId, f.nodeId), eq(telemetry.telemetryType, f.telemetryType))
    );

    return conditions.length === 1 ? conditions[0]! : or(...conditions)!;
  }

  /**
   * Delete old telemetry with special handling for favorites.
   * Non-favorited telemetry is deleted if older than regularCutoff.
   * Favorited telemetry is deleted if older than favoriteCutoff.
   *
   * Keeps branching: MySQL doesn't support .returning().
   */
  async deleteOldTelemetryWithFavorites(
    regularCutoffTimestamp: number,
    favoriteCutoffTimestamp: number,
    favorites: Array<{ nodeId: string; telemetryType: string }>
  ): Promise<{ nonFavoritesDeleted: number; favoritesDeleted: number }> {
    // If no favorites, just delete everything older than regularCutoff
    if (favorites.length === 0) {
      const count = await this.deleteOldTelemetry(regularCutoffTimestamp);
      return { nonFavoritesDeleted: count, favoritesDeleted: 0 };
    }

    // Validate: favoriteCutoff should be <= regularCutoff (earlier timestamp = longer retention)
    const effectiveFavoriteCutoff = Math.min(favoriteCutoffTimestamp, regularCutoffTimestamp);
    const { telemetry } = this.tables;
    const favoritesCondition = this.buildFavoritesCondition(favorites);

    let nonFavoritesDeleted = 0;
    let favoritesDeleted = 0;

    if (this.isMySQL()) {
      // MySQL doesn't support .returning(), so count before deleting
      const nonFavoritesCount = await this.db
        .select({ cnt: count() })
        .from(telemetry)
        .where(and(lt(telemetry.timestamp, regularCutoffTimestamp), not(favoritesCondition!)));
      nonFavoritesDeleted = Number(nonFavoritesCount[0]?.cnt ?? 0);

      await this.db
        .delete(telemetry)
        .where(and(lt(telemetry.timestamp, regularCutoffTimestamp), not(favoritesCondition!)));

      const favoritesCount = await this.db
        .select({ cnt: count() })
        .from(telemetry)
        .where(and(lt(telemetry.timestamp, effectiveFavoriteCutoff), favoritesCondition!));
      favoritesDeleted = Number(favoritesCount[0]?.cnt ?? 0);

      await this.db
        .delete(telemetry)
        .where(and(lt(telemetry.timestamp, effectiveFavoriteCutoff), favoritesCondition!));
    } else {
      // SQLite and PostgreSQL support .returning()
      const deletedNonFavorites = await (this.db as any)
        .delete(telemetry)
        .where(and(lt(telemetry.timestamp, regularCutoffTimestamp), not(favoritesCondition!)))
        .returning({ id: telemetry.id });
      nonFavoritesDeleted = deletedNonFavorites.length;

      const deletedFavorites = await (this.db as any)
        .delete(telemetry)
        .where(and(lt(telemetry.timestamp, effectiveFavoriteCutoff), favoritesCondition!))
        .returning({ id: telemetry.id });
      favoritesDeleted = deletedFavorites.length;
    }

    return { nonFavoritesDeleted, favoritesDeleted };
  }

  /**
   * Delete all telemetry for a specific node, optionally scoped to a source.
   * When sourceId is provided, only rows for that source are removed so
   * deleting a node from one source does not wipe telemetry for the same
   * nodeNum on other sources.
   * Keeps branching: MySQL doesn't support .returning().
   */
  async deleteTelemetryByNode(nodeNum: number, sourceId?: string): Promise<number> {
    const { telemetry } = this.tables;
    const condition = and(eq(telemetry.nodeNum, nodeNum), this.withSourceScope(telemetry, sourceId));

    if (this.isMySQL()) {
      const countResult = await this.db
        .select({ cnt: count() })
        .from(telemetry)
        .where(condition);
      const cnt = Number(countResult[0]?.cnt ?? 0);
      await this.db.delete(telemetry).where(condition);
      return cnt;
    } else {
      const deleted = await (this.db as any)
        .delete(telemetry)
        .where(condition)
        .returning({ id: telemetry.id });
      return deleted.length;
    }
  }

  /**
   * Delete all telemetry, optionally scoped to a single source.
   */
  async deleteAllTelemetry(sourceId?: string): Promise<number> {
    const { telemetry } = this.tables;
    const countQuery = this.db.select({ count: count() }).from(telemetry);
    const result = await (sourceId
      ? countQuery.where(eq(telemetry.sourceId, sourceId))
      : countQuery);
    const deleteCount = Number(result[0].count);
    if (sourceId) {
      await this.db.delete(telemetry).where(eq(telemetry.sourceId, sourceId));
    } else {
      await this.db.delete(telemetry);
    }
    return deleteCount;
  }

  /**
   * Get recent estimated positions for a node.
   * Returns position estimates by pairing estimated_latitude and estimated_longitude
   * telemetry records with matching timestamps.
   */
  async getRecentEstimatedPositions(
    nodeId: string,
    limit: number = 10
  ): Promise<Array<{ latitude: number; longitude: number; timestamp: number }>> {
    // Get estimated_latitude records
    const latRecords = await this.getTelemetryByNode(
      nodeId,
      limit * 2, // Get extra to account for potential unmatched records
      undefined,
      undefined,
      0,
      'estimated_latitude'
    );

    if (latRecords.length === 0) {
      return [];
    }

    // Get estimated_longitude records
    const lonRecords = await this.getTelemetryByNode(
      nodeId,
      limit * 2,
      undefined,
      undefined,
      0,
      'estimated_longitude'
    );

    if (lonRecords.length === 0) {
      return [];
    }

    // Create a map of longitude records by timestamp for efficient lookup
    const lonByTimestamp = new Map<number, number>();
    for (const lon of lonRecords) {
      lonByTimestamp.set(lon.timestamp, lon.value);
    }

    // Pair latitude records with longitude records that have matching timestamps
    const results: Array<{ latitude: number; longitude: number; timestamp: number }> = [];
    for (const lat of latRecords) {
      const lon = lonByTimestamp.get(lat.timestamp);
      if (lon !== undefined) {
        results.push({
          latitude: lat.value,
          longitude: lon,
          timestamp: lat.timestamp,
        });
        if (results.length >= limit) {
          break;
        }
      }
    }

    return results;
  }

  /**
   * Get all nodes with their telemetry types
   */
  async getAllNodesTelemetryTypes(sourceId?: string): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    const { telemetry } = this.tables;

    const result = await this.db
      .selectDistinct({ nodeId: telemetry.nodeId, type: telemetry.telemetryType })
      .from(telemetry)
      .where(this.withSourceScope(telemetry, sourceId));

    for (const r of result) {
      const types = map.get(r.nodeId) || [];
      if (!types.includes(r.type)) {
        types.push(r.type);
      }
      map.set(r.nodeId, types);
    }

    return map;
  }

  /**
   * Get smart hops statistics for a node using rolling 24-hour window
   * Each data point shows min/max/avg of all hops from the previous 24 hours
   *
   * @param nodeId - Node ID to get statistics for
   * @param sinceTimestamp - Start generating output points from this timestamp
   * @param intervalMinutes - Interval between output points in minutes (default: 15)
   * @returns Array of rolling 24-hour hop statistics at regular intervals
   */
  async getSmartHopsStats(
    nodeId: string,
    sinceTimestamp: number,
    intervalMinutes: number = 15
  ): Promise<Array<{ timestamp: number; minHops: number; maxHops: number; avgHops: number }>> {
    // For rolling 24-hour window, we need data from 24 hours before the sinceTimestamp
    const twentyFourHours = 24 * 60 * 60 * 1000;
    const extendedSinceTimestamp = sinceTimestamp - twentyFourHours;

    // Fetch all messageHops telemetry for this node (extended window for rolling calculation)
    const telemetry = await this.getTelemetryByNode(
      nodeId,
      50000, // High limit to get all data in the extended time window
      extendedSinceTimestamp,
      undefined,
      0,
      'messageHops'
    );

    if (telemetry.length === 0) {
      return [];
    }

    // Sort by timestamp ascending
    telemetry.sort((a, b) => a.timestamp - b.timestamp);

    // Generate output points at regular intervals from sinceTimestamp to now
    const intervalMs = intervalMinutes * 60 * 1000;
    const now = Date.now();
    const results: Array<{ timestamp: number; minHops: number; maxHops: number; avgHops: number }> = [];

    // Start from the first interval boundary after sinceTimestamp
    let currentTime = Math.ceil(sinceTimestamp / intervalMs) * intervalMs;

    while (currentTime <= now) {
      // Calculate rolling 24-hour window: [currentTime - 24h, currentTime]
      const windowStart = currentTime - twentyFourHours;
      const windowEnd = currentTime;

      // Get all data points within this 24-hour window
      const windowData = telemetry.filter(
        (t) => t.timestamp >= windowStart && t.timestamp <= windowEnd
      );

      if (windowData.length > 0) {
        const values = windowData.map((t) => t.value);
        const minHops = Math.min(...values);
        const maxHops = Math.max(...values);
        const avgHops = Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * 100) / 100;

        results.push({ timestamp: currentTime, minHops, maxHops, avgHops });
      }

      currentTime += intervalMs;
    }

    return results;
  }

  /**
   * Get link quality history for a node
   * Returns link quality values over time for graphing
   *
   * @param nodeId - Node ID to get statistics for
   * @param sinceTimestamp - Only include telemetry after this timestamp
   * @returns Array of { timestamp, quality } records
   */
  async getLinkQualityHistory(
    nodeId: string,
    sinceTimestamp: number
  ): Promise<Array<{ timestamp: number; quality: number }>> {
    // Fetch all linkQuality telemetry for this node since cutoff
    const telemetry = await this.getTelemetryByNode(
      nodeId,
      10000, // High limit to get all data in the time window
      sinceTimestamp,
      undefined,
      0,
      'linkQuality'
    );

    if (telemetry.length === 0) {
      return [];
    }

    // Sort by timestamp ascending and map to simpler format
    return telemetry
      .sort((a, b) => a.timestamp - b.timestamp)
      .map(record => ({
        timestamp: record.timestamp,
        quality: record.value,
      }));
  }

  /**
   * Telemetry types stored as discrete integer values where averaging produces
   * meaningless floats. These are fetched raw instead of through AVG() grouping.
   */
  private static readonly RAW_VALUE_TYPES = [
    'sats_in_view',
    'messageHops',
    'batteryLevel',
    'numOnlineNodes', 'numTotalNodes',
    'numPacketsTx', 'numPacketsRx', 'numPacketsRxBad',
    'numRxDupe', 'numTxRelay', 'numTxRelayCanceled', 'numTxDropped',
    'systemNodeCount', 'systemDirectNodeCount',
    'paxcounterWifi', 'paxcounterBle',
    'particles03um', 'particles05um', 'particles10um',
    'particles25um', 'particles50um', 'particles100um',
    'co2', 'iaq',
  ];

  /**
   * SQLite-only synchronous averaged telemetry query used by the facade's
   * sync `getTelemetryByNodeAveraged()`. Buckets timestamps into fixed
   * intervals and averages continuous types; fetches discrete types raw.
   *
   * Uses Drizzle query builders against the SQLite client so column names
   * come from the schema (avoids the snake_case/camelCase drift that caused
   * issue #2631).
   */
  getTelemetryByNodeAveragedSqlite(
    nodeId: string,
    sinceTimestamp: number | undefined,
    intervalMinutes: number,
    maxHours: number | undefined,
    sourceId: string | undefined
  ): DbTelemetry[] {
    if (!this.sqliteDb) {
      throw new Error('getTelemetryByNodeAveragedSqlite is SQLite-only');
    }
    const db = this.sqliteDb;
    const telemetry = this.tables.telemetry;
    const rawTypes = TelemetryRepository.RAW_VALUE_TYPES;
    const intervalMs = intervalMinutes * 60 * 1000;

    // Build WHERE conditions shared by averaged and count queries
    const baseConditions = [eq(telemetry.nodeId, nodeId)];
    if (sourceId !== undefined) {
      baseConditions.push(eq(telemetry.sourceId, sourceId));
    }
    if (sinceTimestamp !== undefined) {
      baseConditions.push(gte(telemetry.timestamp, sinceTimestamp));
    }

    // Averaged query: exclude raw types, group by time bucket
    const bucketExpr = sql<number>`CAST((${telemetry.timestamp} / ${intervalMs}) * ${intervalMs} AS INTEGER)`;
    const bucketGroupExpr = sql`CAST(${telemetry.timestamp} / ${intervalMs} AS INTEGER)`;

    // Determine limit based on maxHours
    let averagedLimit: number | undefined;
    if (maxHours !== undefined) {
      const pointsPerHour = 60 / intervalMinutes;
      // Count distinct telemetry types for this node (excluding raw types is
      // not strictly necessary — the multiplier is a conservative upper bound)
      const countRows = db
        .select({ typeCount: sql<number>`COUNT(DISTINCT ${telemetry.telemetryType})` })
        .from(telemetry)
        .where(and(...baseConditions))
        .all();
      const typeCount = Number(countRows[0]?.typeCount ?? 1) || 1;
      const expectedPointsPerType = (maxHours + 1) * pointsPerHour;
      averagedLimit = Math.ceil(expectedPointsPerType * typeCount * 1.5);
    }

    const averagedBuilder = db
      .select({
        nodeId: telemetry.nodeId,
        nodeNum: telemetry.nodeNum,
        telemetryType: telemetry.telemetryType,
        timestamp: bucketExpr.as('timestamp'),
        value: sql<number>`AVG(${telemetry.value})`.as('value'),
        unit: telemetry.unit,
        createdAt: sql<number>`MIN(${telemetry.createdAt})`.as('createdAt'),
      })
      .from(telemetry)
      .where(and(...baseConditions, not(inArray(telemetry.telemetryType, rawTypes))))
      .groupBy(
        telemetry.nodeId,
        telemetry.nodeNum,
        telemetry.telemetryType,
        bucketGroupExpr,
        telemetry.unit
      )
      .orderBy(sql`timestamp DESC`);

    const averagedRows = averagedLimit !== undefined
      ? averagedBuilder.limit(averagedLimit).all()
      : averagedBuilder.all();

    // Raw values query: include only raw types, no averaging
    const rawBuilder = db
      .select({
        nodeId: telemetry.nodeId,
        nodeNum: telemetry.nodeNum,
        telemetryType: telemetry.telemetryType,
        timestamp: telemetry.timestamp,
        value: telemetry.value,
        unit: telemetry.unit,
        createdAt: telemetry.createdAt,
      })
      .from(telemetry)
      .where(and(...baseConditions, inArray(telemetry.telemetryType, rawTypes)))
      .orderBy(desc(telemetry.timestamp));

    let rawRows;
    if (maxHours !== undefined) {
      // Raw values are sparse — ~10/hour/type upper bound with 50% padding
      const rawLimit = Math.ceil((maxHours + 1) * 10 * rawTypes.length * 1.5);
      rawRows = rawBuilder.limit(rawLimit).all();
    } else {
      rawRows = rawBuilder.all();
    }

    // Convert rows to DbTelemetry shape (null unit → undefined)
    const toDbTelemetry = (r: any): DbTelemetry => ({
      nodeId: r.nodeId,
      nodeNum: Number(r.nodeNum),
      telemetryType: r.telemetryType,
      timestamp: Number(r.timestamp),
      value: Number(r.value),
      unit: r.unit ?? undefined,
      createdAt: Number(r.createdAt),
    });

    return [...averagedRows.map(toDbTelemetry), ...rawRows.map(toDbTelemetry)];
  }

  /**
   * Get latest telemetry record with non-null packetTimestamp per node.
   * Used by time-offset diagnostics. SQLite/MySQL use INNER JOIN on MAX,
   * PostgreSQL uses DISTINCT ON for efficiency.
   */
  async getLatestPacketTimestampsPerNode(
    minValidTimestampMs: number,
    sourceId?: string
  ): Promise<Array<{ nodeNum: number; timestamp: number; packetTimestamp: number }>> {
    if (this.isPostgres()) {
      const db = this.getPostgresDb();
      const sourceFilter = sourceId
        ? sql` AND "sourceId" = ${sourceId}`
        : sql``;
      const result = await db.execute(sql`
        SELECT DISTINCT ON ("nodeNum") "nodeNum", "timestamp", "packetTimestamp"
        FROM telemetry
        WHERE "packetTimestamp" IS NOT NULL AND "packetTimestamp" > ${minValidTimestampMs}${sourceFilter}
        ORDER BY "nodeNum", "timestamp" DESC
      `);
      return result.rows.map((r: any) => ({
        nodeNum: Number(r.nodeNum),
        timestamp: Number(r.timestamp),
        packetTimestamp: Number(r.packetTimestamp),
      }));
    }

    if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const sourceFilterOuter = sourceId ? sql` AND t.sourceId = ${sourceId}` : sql``;
      const sourceFilterInner = sourceId ? sql` AND sourceId = ${sourceId}` : sql``;
      const [rows] = await (db as any).execute(sql`
        SELECT t.nodeNum, t.timestamp, t.packetTimestamp
        FROM telemetry t
        INNER JOIN (
          SELECT nodeNum, MAX(timestamp) as maxTs
          FROM telemetry
          WHERE packetTimestamp IS NOT NULL AND packetTimestamp > ${minValidTimestampMs}${sourceFilterInner}
          GROUP BY nodeNum
        ) latest ON t.nodeNum = latest.nodeNum AND t.timestamp = latest.maxTs
        WHERE t.packetTimestamp IS NOT NULL AND t.packetTimestamp > ${minValidTimestampMs}${sourceFilterOuter}
      `);
      return (rows as any[]).map((r: any) => ({
        nodeNum: Number(r.nodeNum),
        timestamp: Number(r.timestamp),
        packetTimestamp: Number(r.packetTimestamp),
      }));
    }

    // SQLite
    const db = this.getSqliteDb();
    const sourceFilterOuter = sourceId ? sql` AND t.sourceId = ${sourceId}` : sql``;
    const sourceFilterInner = sourceId ? sql` AND sourceId = ${sourceId}` : sql``;
    const rows = await db.all<{ nodeNum: number | bigint; timestamp: number; packetTimestamp: number }>(
      sql`SELECT t.nodeNum, t.timestamp, t.packetTimestamp
          FROM telemetry t
          INNER JOIN (
            SELECT nodeNum, MAX(timestamp) as maxTs
            FROM telemetry
            WHERE packetTimestamp IS NOT NULL AND packetTimestamp > ${minValidTimestampMs}${sourceFilterInner}
            GROUP BY nodeNum
          ) latest ON t.nodeNum = latest.nodeNum AND t.timestamp = latest.maxTs
          WHERE t.packetTimestamp IS NOT NULL AND t.packetTimestamp > ${minValidTimestampMs}${sourceFilterOuter}`
    );
    return rows.map((r: any) => ({
      nodeNum: Number(r.nodeNum),
      timestamp: Number(r.timestamp),
      packetTimestamp: Number(r.packetTimestamp),
    }));
  }

  /**
   * Delete all estimated position telemetry (estimated_latitude, estimated_longitude).
   * Used during migration to force recalculation with a new algorithm.
   * Returns the number of rows deleted.
   */
  async deleteAllEstimatedPositions(): Promise<number> {
    const { telemetry } = this.tables;
    const types = ['estimated_latitude', 'estimated_longitude'];
    const condition = inArray(telemetry.telemetryType, types);

    if (this.isMySQL()) {
      const countRows = await this.db
        .select({ cnt: count() })
        .from(telemetry)
        .where(condition);
      const cnt = Number(countRows[0]?.cnt ?? 0);
      await this.db.delete(telemetry).where(condition);
      return cnt;
    }
    const deleted = await (this.db as any)
      .delete(telemetry)
      .where(condition)
      .returning({ id: telemetry.id });
    return deleted.length;
  }

  // ============ SQLite-only sync methods ============
  // These exist because facade methods on DatabaseService have legacy sync
  // signatures that non-test callers still depend on. For PG/MySQL callers
  // use the async equivalents above.

  /**
   * Synchronously get total telemetry count (SQLite only).
   */
  getTelemetryCountSync(): number {
    const db = this.getSqliteDb();
    const { telemetry } = this.tables;
    const rows = db.select({ count: count() }).from(telemetry).all();
    return Number((rows[0] as any).count);
  }

  /**
   * Synchronously count telemetry for a node with optional filters (SQLite only).
   */
  getTelemetryCountByNodeSync(
    nodeId: string,
    sinceTimestamp?: number,
    beforeTimestamp?: number,
    telemetryType?: string
  ): number {
    const db = this.getSqliteDb();
    const { telemetry } = this.tables;
    const conditions = [eq(telemetry.nodeId, nodeId)];
    if (sinceTimestamp !== undefined) {
      conditions.push(gte(telemetry.timestamp, sinceTimestamp));
    }
    if (beforeTimestamp !== undefined) {
      conditions.push(lt(telemetry.timestamp, beforeTimestamp));
    }
    if (telemetryType !== undefined) {
      conditions.push(eq(telemetry.telemetryType, telemetryType));
    }
    const rows = db
      .select({ count: count() })
      .from(telemetry)
      .where(and(...conditions))
      .all();
    return Number((rows[0] as any).count);
  }

  /**
   * Synchronously delete ALL telemetry for a given node (SQLite only).
   * Returns the number of rows deleted.
   */
  deleteTelemetryByNodeSync(nodeNum: number): number {
    const db = this.getSqliteDb();
    const { telemetry } = this.tables;
    const result = db
      .delete(telemetry)
      .where(eq(telemetry.nodeNum, nodeNum))
      .run();
    return Number((result as any).changes ?? 0);
  }

  /**
   * Synchronously delete all telemetry rows (SQLite only),
   * optionally scoped to a single source.
   * Returns the number of rows deleted.
   */
  deleteAllTelemetrySync(sourceId?: string): number {
    const db = this.getSqliteDb();
    const { telemetry } = this.tables;
    const result = sourceId
      ? db.delete(telemetry).where(eq(telemetry.sourceId, sourceId)).run()
      : db.delete(telemetry).run();
    return Number((result as any).changes ?? 0);
  }

  /**
   * Synchronously delete telemetry older than a cutoff timestamp (SQLite only).
   * Returns the number of rows deleted.
   */
  deleteOldTelemetrySync(cutoffTimestamp: number): number {
    const db = this.getSqliteDb();
    const { telemetry } = this.tables;
    const result = db
      .delete(telemetry)
      .where(lt(telemetry.timestamp, cutoffTimestamp))
      .run();
    return Number((result as any).changes ?? 0);
  }

  /**
   * Synchronously insert a telemetry row via Drizzle query builder (SQLite only).
   * Does NOT apply the unique-on-packetId suppression from insertTelemetry; this
   * matches the legacy facade sync behavior which always inserts.
   */
  insertTelemetrySync(telemetryData: DbTelemetry, sourceId?: string): void {
    const db = this.getSqliteDb();
    const { telemetry } = this.tables;
    const values: any = {
      nodeId: telemetryData.nodeId,
      nodeNum: telemetryData.nodeNum,
      telemetryType: telemetryData.telemetryType,
      timestamp: telemetryData.timestamp,
      value: telemetryData.value,
      unit: telemetryData.unit ?? null,
      createdAt: telemetryData.createdAt,
      packetTimestamp: telemetryData.packetTimestamp ?? null,
      packetId: telemetryData.packetId ?? null,
      channel: telemetryData.channel ?? null,
      precisionBits: telemetryData.precisionBits ?? null,
      gpsAccuracy: telemetryData.gpsAccuracy ?? null,
    };
    if (sourceId) {
      values.sourceId = sourceId;
    }
    db.insert(telemetry).values(values).run();
  }

  /**
   * Synchronously fetch telemetry for a node with optional filters (SQLite only).
   */
  getTelemetryByNodeSync(
    nodeId: string,
    limit: number = 100,
    sinceTimestamp?: number,
    beforeTimestamp?: number,
    offset: number = 0,
    telemetryType?: string
  ): DbTelemetry[] {
    const db = this.getSqliteDb();
    const { telemetry } = this.tables;
    const conditions = [eq(telemetry.nodeId, nodeId)];
    if (sinceTimestamp !== undefined) conditions.push(gte(telemetry.timestamp, sinceTimestamp));
    if (beforeTimestamp !== undefined) conditions.push(lt(telemetry.timestamp, beforeTimestamp));
    if (telemetryType !== undefined) conditions.push(eq(telemetry.telemetryType, telemetryType));

    const rows = db
      .select()
      .from(telemetry)
      .where(and(...conditions))
      .orderBy(desc(telemetry.timestamp))
      .limit(limit)
      .offset(offset)
      .all();
    return (rows as any[]).map((r) => normalizeSyncTelemetryRow(this.normalizeBigInts(r))) as DbTelemetry[];
  }

  /**
   * Synchronously fetch telemetry by type (SQLite only).
   */
  getTelemetryByTypeSync(telemetryType: string, limit: number = 100): DbTelemetry[] {
    const db = this.getSqliteDb();
    const { telemetry } = this.tables;
    const rows = db
      .select()
      .from(telemetry)
      .where(eq(telemetry.telemetryType, telemetryType))
      .orderBy(desc(telemetry.timestamp))
      .limit(limit)
      .all();
    return (rows as any[]).map((r) => normalizeSyncTelemetryRow(this.normalizeBigInts(r))) as DbTelemetry[];
  }

  /**
   * Synchronously get the latest record for each telemetry type for a node (SQLite only).
   */
  getLatestTelemetryByNodeSync(nodeId: string): DbTelemetry[] {
    const db = this.getSqliteDb();
    const { telemetry } = this.tables;
    // Correlated subquery: latest row per (nodeId, telemetryType)
    const rows = db
      .select()
      .from(telemetry)
      .where(
        and(
          eq(telemetry.nodeId, nodeId),
          sql`${telemetry.timestamp} = (
            SELECT MAX(t2.timestamp) FROM ${telemetry} t2
            WHERE t2.nodeId = ${telemetry.nodeId} AND t2.telemetryType = ${telemetry.telemetryType}
          )`
        )
      )
      .orderBy(telemetry.telemetryType)
      .all();
    return (rows as any[]).map((r) => normalizeSyncTelemetryRow(this.normalizeBigInts(r))) as DbTelemetry[];
  }

  /**
   * Synchronously get the latest record for a specific telemetry type (SQLite only).
   */
  getLatestTelemetryForTypeSync(nodeId: string, telemetryType: string): DbTelemetry | null {
    const db = this.getSqliteDb();
    const { telemetry } = this.tables;
    const rows = db
      .select()
      .from(telemetry)
      .where(and(eq(telemetry.nodeId, nodeId), eq(telemetry.telemetryType, telemetryType)))
      .orderBy(desc(telemetry.timestamp))
      .limit(1)
      .all();
    if (rows.length === 0) return null;
    return normalizeSyncTelemetryRow(this.normalizeBigInts(rows[0])) as DbTelemetry;
  }

  /**
   * Synchronously get distinct telemetry types for a node (SQLite only).
   */
  getNodeTelemetryTypesSync(nodeId: string): string[] {
    const db = this.getSqliteDb();
    const { telemetry } = this.tables;
    const rows = db
      .selectDistinct({ telemetryType: telemetry.telemetryType })
      .from(telemetry)
      .where(eq(telemetry.nodeId, nodeId))
      .all();
    return (rows as any[]).map((r) => r.telemetryType);
  }

  /**
   * Synchronously get all nodes with their telemetry types (SQLite only).
   * Returns Map<nodeId, string[]>.
   */
  getAllNodesTelemetryTypesSync(): Map<string, string[]> {
    const db = this.getSqliteDb();
    const { telemetry } = this.tables;
    const rows = db
      .selectDistinct({ nodeId: telemetry.nodeId, telemetryType: telemetry.telemetryType })
      .from(telemetry)
      .all();
    const map = new Map<string, string[]>();
    for (const r of rows as any[]) {
      const types = map.get(r.nodeId) || [];
      if (!types.includes(r.telemetryType)) types.push(r.telemetryType);
      map.set(r.nodeId, types);
    }
    return map;
  }

  /**
   * Synchronously delete all estimated position telemetry (SQLite only).
   * Returns rows deleted.
   */
  deleteAllEstimatedPositionsSync(): number {
    const db = this.getSqliteDb();
    const { telemetry } = this.tables;
    const types = ['estimated_latitude', 'estimated_longitude'];
    const result = db.delete(telemetry).where(inArray(telemetry.telemetryType, types)).run();
    return Number((result as any).changes ?? 0);
  }

  /**
   * Synchronously delete old telemetry with favorites retention (SQLite only).
   * Non-favorited telemetry older than regularCutoffTimestamp is deleted.
   * Favorited telemetry older than favoriteCutoffTimestamp is deleted.
   * Returns { nonFavoritesDeleted, favoritesDeleted }.
   */
  deleteOldTelemetryWithFavoritesSync(
    regularCutoffTimestamp: number,
    favoriteCutoffTimestamp: number,
    favorites: TelemetryFavorite[]
  ): { nonFavoritesDeleted: number; favoritesDeleted: number } {
    if (favorites.length === 0) {
      const nonFavoritesDeleted = this.deleteOldTelemetrySync(regularCutoffTimestamp);
      return { nonFavoritesDeleted, favoritesDeleted: 0 };
    }

    const db = this.getSqliteDb();
    const { telemetry } = this.tables;
    const favoritesCondition = this.buildFavoritesCondition(favorites)!;

    const nonFavoritesResult = db
      .delete(telemetry)
      .where(and(lt(telemetry.timestamp, regularCutoffTimestamp), not(favoritesCondition)))
      .run();
    const nonFavoritesDeleted = Number((nonFavoritesResult as any).changes ?? 0);

    const favoritesResult = db
      .delete(telemetry)
      .where(and(lt(telemetry.timestamp, favoriteCutoffTimestamp), favoritesCondition))
      .run();
    const favoritesDeleted = Number((favoritesResult as any).changes ?? 0);

    return { nonFavoritesDeleted, favoritesDeleted };
  }
}
