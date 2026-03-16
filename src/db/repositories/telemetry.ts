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
 * Repository for telemetry operations
 */
export class TelemetryRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  /**
   * Insert a telemetry record
   */
  async insertTelemetry(telemetryData: DbTelemetry): Promise<void> {
    const { telemetry } = this.tables;
    const values = {
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

    await this.db.insert(telemetry).values(values);
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
    telemetryType?: string
  ): Promise<number> {
    const { telemetry } = this.tables;
    let conditions = [eq(telemetry.nodeId, nodeId)];

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
    telemetryType?: string
  ): Promise<DbTelemetry[]> {
    const { telemetry } = this.tables;
    let conditions = [eq(telemetry.nodeId, nodeId)];

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
    sinceTimestamp?: number
  ): Promise<DbTelemetry[]> {
    const positionTypes = ['latitude', 'longitude', 'altitude', 'ground_speed', 'ground_track'];
    const { telemetry } = this.tables;

    let conditions = [
      eq(telemetry.nodeId, nodeId),
      inArray(telemetry.telemetryType, positionTypes),
    ];

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
   * Keeps branching: PostgreSQL uses DISTINCT ON, SQLite/MySQL use subquery with MAX.
   * Different raw SQL and result shapes per dialect.
   */
  async getLatestTelemetryValueForAllNodes(telemetryType: string): Promise<Map<string, number>> {
    const result = new Map<string, number>();

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const rows = await db.all<{ nodeId: string; value: number }>(
        sql`SELECT t.nodeId, t.value FROM telemetry t
            INNER JOIN (
              SELECT nodeId, MAX(timestamp) as maxTs
              FROM telemetry WHERE telemetryType = ${telemetryType}
              GROUP BY nodeId
            ) latest ON t.nodeId = latest.nodeId AND t.timestamp = latest.maxTs
            WHERE t.telemetryType = ${telemetryType}`
      );
      for (const row of rows) {
        result.set(row.nodeId, Number(row.value));
      }
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const [rows] = await (db as any).execute(
        sql`SELECT t.nodeId, t.value FROM telemetry t
            INNER JOIN (
              SELECT nodeId, MAX(timestamp) as maxTs
              FROM telemetry WHERE telemetryType = ${telemetryType}
              GROUP BY nodeId
            ) latest ON t.nodeId = latest.nodeId AND t.timestamp = latest.maxTs
            WHERE t.telemetryType = ${telemetryType}`
      );
      for (const row of rows as any[]) {
        result.set(row.nodeId, Number(row.value));
      }
    } else {
      const db = this.getPostgresDb();
      const rows = await db.execute(
        sql`SELECT DISTINCT ON ("nodeId") "nodeId", value
            FROM telemetry
            WHERE "telemetryType" = ${telemetryType}
            ORDER BY "nodeId", timestamp DESC`
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

    return result.map(r => r.type);
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
        .select({ id: telemetry.id })
        .from(telemetry)
        .where(condition);
      if (countResult.length === 0) return false;
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
   * Purge telemetry for a node.
   * Delegates to deleteTelemetryByNode.
   */
  async purgeNodeTelemetry(nodeNum: number): Promise<number> {
    return this.deleteTelemetryByNode(nodeNum);
  }

  /**
   * Purge position history for a specific node.
   * Deletes only position-related telemetry types (latitude, longitude, altitude, etc.)
   * Keeps branching: MySQL doesn't support .returning().
   */
  async purgePositionHistory(nodeNum: number): Promise<number> {
    const positionTypes = [
      'latitude', 'longitude', 'altitude',
      'ground_speed', 'ground_track',
      'estimated_latitude', 'estimated_longitude',
    ];
    const { telemetry } = this.tables;
    const condition = and(
      eq(telemetry.nodeNum, nodeNum),
      inArray(telemetry.telemetryType, positionTypes)
    );

    if (this.isMySQL()) {
      const countResult = await this.db
        .select({ id: telemetry.id })
        .from(telemetry)
        .where(condition);
      const cnt = countResult.length;
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
        .select({ id: telemetry.id })
        .from(telemetry)
        .where(lt(telemetry.timestamp, cutoffTimestamp));
      const cnt = countResult.length;
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
  private buildFavoritesCondition(
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
        .select({ id: telemetry.id })
        .from(telemetry)
        .where(and(lt(telemetry.timestamp, regularCutoffTimestamp), not(favoritesCondition!)));
      nonFavoritesDeleted = nonFavoritesCount.length;

      await this.db
        .delete(telemetry)
        .where(and(lt(telemetry.timestamp, regularCutoffTimestamp), not(favoritesCondition!)));

      const favoritesCount = await this.db
        .select({ id: telemetry.id })
        .from(telemetry)
        .where(and(lt(telemetry.timestamp, effectiveFavoriteCutoff), favoritesCondition!));
      favoritesDeleted = favoritesCount.length;

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
   * Delete all telemetry for a specific node.
   * Keeps branching: MySQL doesn't support .returning().
   */
  async deleteTelemetryByNode(nodeNum: number): Promise<number> {
    const { telemetry } = this.tables;

    if (this.isMySQL()) {
      const countResult = await this.db
        .select({ id: telemetry.id })
        .from(telemetry)
        .where(eq(telemetry.nodeNum, nodeNum));
      const cnt = countResult.length;
      await this.db.delete(telemetry).where(eq(telemetry.nodeNum, nodeNum));
      return cnt;
    } else {
      const deleted = await (this.db as any)
        .delete(telemetry)
        .where(eq(telemetry.nodeNum, nodeNum))
        .returning({ id: telemetry.id });
      return deleted.length;
    }
  }

  /**
   * Delete all telemetry
   */
  async deleteAllTelemetry(): Promise<number> {
    const { telemetry } = this.tables;
    const result = await this.db.select({ count: count() }).from(telemetry);
    const deleteCount = Number(result[0].count);
    await this.db.delete(telemetry);
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
  async getAllNodesTelemetryTypes(): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    const { telemetry } = this.tables;

    const result = await this.db
      .selectDistinct({ nodeId: telemetry.nodeId, type: telemetry.telemetryType })
      .from(telemetry);

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
}
