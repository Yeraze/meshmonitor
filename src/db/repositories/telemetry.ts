/**
 * Telemetry Repository
 *
 * Handles all telemetry-related database operations.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, lt, gte, and, desc, inArray, or, not, SQL } from 'drizzle-orm';
import { telemetrySqlite, telemetryPostgres, telemetryMysql } from '../schema/telemetry.js';
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

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db.insert(telemetrySqlite).values(values);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db.insert(telemetryMysql).values(values);
    } else {
      const db = this.getPostgresDb();
      await db.insert(telemetryPostgres).values(values);
    }
  }

  /**
   * Get telemetry count
   */
  async getTelemetryCount(): Promise<number> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db.select().from(telemetrySqlite);
      return result.length;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db.select().from(telemetryMysql);
      return result.length;
    } else {
      const db = this.getPostgresDb();
      const result = await db.select().from(telemetryPostgres);
      return result.length;
    }
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
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      let conditions = [eq(telemetrySqlite.nodeId, nodeId)];

      if (sinceTimestamp !== undefined) {
        conditions.push(gte(telemetrySqlite.timestamp, sinceTimestamp));
      }
      if (beforeTimestamp !== undefined) {
        conditions.push(lt(telemetrySqlite.timestamp, beforeTimestamp));
      }
      if (telemetryType !== undefined) {
        conditions.push(eq(telemetrySqlite.telemetryType, telemetryType));
      }

      const result = await db
        .select()
        .from(telemetrySqlite)
        .where(and(...conditions));

      return result.length;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      let conditions = [eq(telemetryMysql.nodeId, nodeId)];

      if (sinceTimestamp !== undefined) {
        conditions.push(gte(telemetryMysql.timestamp, sinceTimestamp));
      }
      if (beforeTimestamp !== undefined) {
        conditions.push(lt(telemetryMysql.timestamp, beforeTimestamp));
      }
      if (telemetryType !== undefined) {
        conditions.push(eq(telemetryMysql.telemetryType, telemetryType));
      }

      const result = await db
        .select()
        .from(telemetryMysql)
        .where(and(...conditions));

      return result.length;
    } else {
      const db = this.getPostgresDb();
      let conditions = [eq(telemetryPostgres.nodeId, nodeId)];

      if (sinceTimestamp !== undefined) {
        conditions.push(gte(telemetryPostgres.timestamp, sinceTimestamp));
      }
      if (beforeTimestamp !== undefined) {
        conditions.push(lt(telemetryPostgres.timestamp, beforeTimestamp));
      }
      if (telemetryType !== undefined) {
        conditions.push(eq(telemetryPostgres.telemetryType, telemetryType));
      }

      const result = await db
        .select()
        .from(telemetryPostgres)
        .where(and(...conditions));

      return result.length;
    }
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
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      let conditions = [eq(telemetrySqlite.nodeId, nodeId)];

      if (sinceTimestamp !== undefined) {
        conditions.push(gte(telemetrySqlite.timestamp, sinceTimestamp));
      }
      if (beforeTimestamp !== undefined) {
        conditions.push(lt(telemetrySqlite.timestamp, beforeTimestamp));
      }
      if (telemetryType !== undefined) {
        conditions.push(eq(telemetrySqlite.telemetryType, telemetryType));
      }

      const result = await db
        .select()
        .from(telemetrySqlite)
        .where(and(...conditions))
        .orderBy(desc(telemetrySqlite.timestamp))
        .limit(limit)
        .offset(offset);

      return result.map(t => this.normalizeBigInts(t) as DbTelemetry);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      let conditions = [eq(telemetryMysql.nodeId, nodeId)];

      if (sinceTimestamp !== undefined) {
        conditions.push(gte(telemetryMysql.timestamp, sinceTimestamp));
      }
      if (beforeTimestamp !== undefined) {
        conditions.push(lt(telemetryMysql.timestamp, beforeTimestamp));
      }
      if (telemetryType !== undefined) {
        conditions.push(eq(telemetryMysql.telemetryType, telemetryType));
      }

      const result = await db
        .select()
        .from(telemetryMysql)
        .where(and(...conditions))
        .orderBy(desc(telemetryMysql.timestamp))
        .limit(limit)
        .offset(offset);

      return result as DbTelemetry[];
    } else {
      const db = this.getPostgresDb();
      let conditions = [eq(telemetryPostgres.nodeId, nodeId)];

      if (sinceTimestamp !== undefined) {
        conditions.push(gte(telemetryPostgres.timestamp, sinceTimestamp));
      }
      if (beforeTimestamp !== undefined) {
        conditions.push(lt(telemetryPostgres.timestamp, beforeTimestamp));
      }
      if (telemetryType !== undefined) {
        conditions.push(eq(telemetryPostgres.telemetryType, telemetryType));
      }

      const result = await db
        .select()
        .from(telemetryPostgres)
        .where(and(...conditions))
        .orderBy(desc(telemetryPostgres.timestamp))
        .limit(limit)
        .offset(offset);

      return result as DbTelemetry[];
    }
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

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      let conditions = [
        eq(telemetrySqlite.nodeId, nodeId),
        inArray(telemetrySqlite.telemetryType, positionTypes),
      ];

      if (sinceTimestamp !== undefined) {
        conditions.push(gte(telemetrySqlite.timestamp, sinceTimestamp));
      }

      const result = await db
        .select()
        .from(telemetrySqlite)
        .where(and(...conditions))
        .orderBy(desc(telemetrySqlite.timestamp))
        .limit(limit);

      return result.map(t => this.normalizeBigInts(t) as DbTelemetry);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      let conditions = [
        eq(telemetryMysql.nodeId, nodeId),
        inArray(telemetryMysql.telemetryType, positionTypes),
      ];

      if (sinceTimestamp !== undefined) {
        conditions.push(gte(telemetryMysql.timestamp, sinceTimestamp));
      }

      const result = await db
        .select()
        .from(telemetryMysql)
        .where(and(...conditions))
        .orderBy(desc(telemetryMysql.timestamp))
        .limit(limit);

      return result as DbTelemetry[];
    } else {
      const db = this.getPostgresDb();
      let conditions = [
        eq(telemetryPostgres.nodeId, nodeId),
        inArray(telemetryPostgres.telemetryType, positionTypes),
      ];

      if (sinceTimestamp !== undefined) {
        conditions.push(gte(telemetryPostgres.timestamp, sinceTimestamp));
      }

      const result = await db
        .select()
        .from(telemetryPostgres)
        .where(and(...conditions))
        .orderBy(desc(telemetryPostgres.timestamp))
        .limit(limit);

      return result as DbTelemetry[];
    }
  }

  /**
   * Get telemetry by type
   */
  async getTelemetryByType(telemetryType: string, limit: number = 100): Promise<DbTelemetry[]> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db
        .select()
        .from(telemetrySqlite)
        .where(eq(telemetrySqlite.telemetryType, telemetryType))
        .orderBy(desc(telemetrySqlite.timestamp))
        .limit(limit);

      return result.map(t => this.normalizeBigInts(t) as DbTelemetry);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db
        .select()
        .from(telemetryMysql)
        .where(eq(telemetryMysql.telemetryType, telemetryType))
        .orderBy(desc(telemetryMysql.timestamp))
        .limit(limit);

      return result as DbTelemetry[];
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .select()
        .from(telemetryPostgres)
        .where(eq(telemetryPostgres.telemetryType, telemetryType))
        .orderBy(desc(telemetryPostgres.timestamp))
        .limit(limit);

      return result as DbTelemetry[];
    }
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
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db
        .select()
        .from(telemetrySqlite)
        .where(
          and(
            eq(telemetrySqlite.nodeId, nodeId),
            eq(telemetrySqlite.telemetryType, telemetryType)
          )
        )
        .orderBy(desc(telemetrySqlite.timestamp))
        .limit(1);

      if (result.length === 0) return null;
      return this.normalizeBigInts(result[0]) as DbTelemetry;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db
        .select()
        .from(telemetryMysql)
        .where(
          and(
            eq(telemetryMysql.nodeId, nodeId),
            eq(telemetryMysql.telemetryType, telemetryType)
          )
        )
        .orderBy(desc(telemetryMysql.timestamp))
        .limit(1);

      if (result.length === 0) return null;
      return result[0] as DbTelemetry;
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .select()
        .from(telemetryPostgres)
        .where(
          and(
            eq(telemetryPostgres.nodeId, nodeId),
            eq(telemetryPostgres.telemetryType, telemetryType)
          )
        )
        .orderBy(desc(telemetryPostgres.timestamp))
        .limit(1);

      if (result.length === 0) return null;
      return result[0] as DbTelemetry;
    }
  }

  /**
   * Get all telemetry types for a node
   */
  async getNodeTelemetryTypes(nodeId: string): Promise<string[]> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db
        .selectDistinct({ type: telemetrySqlite.telemetryType })
        .from(telemetrySqlite)
        .where(eq(telemetrySqlite.nodeId, nodeId));

      return result.map(r => r.type);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db
        .selectDistinct({ type: telemetryMysql.telemetryType })
        .from(telemetryMysql)
        .where(eq(telemetryMysql.nodeId, nodeId));

      return result.map(r => r.type);
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .selectDistinct({ type: telemetryPostgres.telemetryType })
        .from(telemetryPostgres)
        .where(eq(telemetryPostgres.nodeId, nodeId));

      return result.map(r => r.type);
    }
  }

  /**
   * Delete telemetry by node and type.
   * Uses direct DELETE WHERE for optimal performance.
   */
  async deleteTelemetryByNodeAndType(nodeId: string, telemetryType: string): Promise<boolean> {
    const condition = (schema: { nodeId: any; telemetryType: any }) =>
      and(eq(schema.nodeId, nodeId), eq(schema.telemetryType, telemetryType));

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const deleted = await db
        .delete(telemetrySqlite)
        .where(condition(telemetrySqlite))
        .returning({ id: telemetrySqlite.id });
      return deleted.length > 0;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      // MySQL doesn't support .returning(), so count first
      const countResult = await db
        .select({ id: telemetryMysql.id })
        .from(telemetryMysql)
        .where(condition(telemetryMysql));
      if (countResult.length === 0) return false;
      await db.delete(telemetryMysql).where(condition(telemetryMysql));
      return true;
    } else {
      const db = this.getPostgresDb();
      const deleted = await db
        .delete(telemetryPostgres)
        .where(condition(telemetryPostgres))
        .returning({ id: telemetryPostgres.id });
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
   * Cleanup old telemetry data.
   * Delegates to deleteOldTelemetry with calculated cutoff timestamp.
   */
  async cleanupOldTelemetry(days: number = 30): Promise<number> {
    const cutoff = this.now() - (days * 24 * 60 * 60 * 1000);
    return this.deleteOldTelemetry(cutoff);
  }

  /**
   * Delete telemetry older than a given timestamp.
   * Uses direct DELETE WHERE for optimal performance.
   */
  async deleteOldTelemetry(cutoffTimestamp: number): Promise<number> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const deleted = await db
        .delete(telemetrySqlite)
        .where(lt(telemetrySqlite.timestamp, cutoffTimestamp))
        .returning({ id: telemetrySqlite.id });
      return deleted.length;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      // MySQL doesn't support .returning(), so count first
      const countResult = await db
        .select({ id: telemetryMysql.id })
        .from(telemetryMysql)
        .where(lt(telemetryMysql.timestamp, cutoffTimestamp));
      const count = countResult.length;
      await db
        .delete(telemetryMysql)
        .where(lt(telemetryMysql.timestamp, cutoffTimestamp));
      return count;
    } else {
      const db = this.getPostgresDb();
      const deleted = await db
        .delete(telemetryPostgres)
        .where(lt(telemetryPostgres.timestamp, cutoffTimestamp))
        .returning({ id: telemetryPostgres.id });
      return deleted.length;
    }
  }

  /**
   * Build a SQL condition that matches any of the favorited (nodeId, telemetryType) pairs.
   * Returns null if favorites array is empty.
   */
  private buildFavoritesCondition<T extends { nodeId: any; telemetryType: any }>(
    schema: T,
    favorites: Array<{ nodeId: string; telemetryType: string }>
  ): SQL | null {
    if (favorites.length === 0) return null;

    const conditions = favorites.map(f =>
      and(eq(schema.nodeId, f.nodeId), eq(schema.telemetryType, f.telemetryType))
    );

    return conditions.length === 1 ? conditions[0]! : or(...conditions)!;
  }

  /**
   * Delete old telemetry with special handling for favorites.
   * Non-favorited telemetry is deleted if older than regularCutoff.
   * Favorited telemetry is deleted if older than favoriteCutoff.
   *
   * Uses database-level filtering and batch deletes for optimal performance.
   *
   * @param regularCutoffTimestamp - Cutoff for non-favorited telemetry (shorter retention)
   * @param favoriteCutoffTimestamp - Cutoff for favorited telemetry (longer retention, should be <= regularCutoff)
   * @param favorites - Array of { nodeId, telemetryType } that are favorited
   * @returns Number of deleted records for each category
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
    // If misconfigured, use the more conservative (earlier) cutoff for favorites
    const effectiveFavoriteCutoff = Math.min(favoriteCutoffTimestamp, regularCutoffTimestamp);

    let nonFavoritesDeleted = 0;
    let favoritesDeleted = 0;

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const favoritesCondition = this.buildFavoritesCondition(telemetrySqlite, favorites);

      // Delete non-favorited telemetry older than regularCutoff using direct DELETE WHERE
      // Uses .returning() to get count of deleted rows (SQLite supports this)
      const deletedNonFavorites = await db
        .delete(telemetrySqlite)
        .where(and(lt(telemetrySqlite.timestamp, regularCutoffTimestamp), not(favoritesCondition!)))
        .returning({ id: telemetrySqlite.id });
      nonFavoritesDeleted = deletedNonFavorites.length;

      // Delete favorited telemetry older than favoriteCutoff
      const deletedFavorites = await db
        .delete(telemetrySqlite)
        .where(and(lt(telemetrySqlite.timestamp, effectiveFavoriteCutoff), favoritesCondition!))
        .returning({ id: telemetrySqlite.id });
      favoritesDeleted = deletedFavorites.length;

    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const favoritesCondition = this.buildFavoritesCondition(telemetryMysql, favorites);

      // MySQL doesn't support .returning(), so count before deleting
      const nonFavoritesCount = await db
        .select({ id: telemetryMysql.id })
        .from(telemetryMysql)
        .where(and(lt(telemetryMysql.timestamp, regularCutoffTimestamp), not(favoritesCondition!)));
      nonFavoritesDeleted = nonFavoritesCount.length;

      await db
        .delete(telemetryMysql)
        .where(and(lt(telemetryMysql.timestamp, regularCutoffTimestamp), not(favoritesCondition!)));

      const favoritesCount = await db
        .select({ id: telemetryMysql.id })
        .from(telemetryMysql)
        .where(and(lt(telemetryMysql.timestamp, effectiveFavoriteCutoff), favoritesCondition!));
      favoritesDeleted = favoritesCount.length;

      await db
        .delete(telemetryMysql)
        .where(and(lt(telemetryMysql.timestamp, effectiveFavoriteCutoff), favoritesCondition!));

    } else {
      const db = this.getPostgresDb();
      const favoritesCondition = this.buildFavoritesCondition(telemetryPostgres, favorites);

      // Delete non-favorited telemetry older than regularCutoff using direct DELETE WHERE
      // Uses .returning() to get count of deleted rows (PostgreSQL supports this)
      const deletedNonFavorites = await db
        .delete(telemetryPostgres)
        .where(and(lt(telemetryPostgres.timestamp, regularCutoffTimestamp), not(favoritesCondition!)))
        .returning({ id: telemetryPostgres.id });
      nonFavoritesDeleted = deletedNonFavorites.length;

      // Delete favorited telemetry older than favoriteCutoff
      const deletedFavorites = await db
        .delete(telemetryPostgres)
        .where(and(lt(telemetryPostgres.timestamp, effectiveFavoriteCutoff), favoritesCondition!))
        .returning({ id: telemetryPostgres.id });
      favoritesDeleted = deletedFavorites.length;
    }

    return { nonFavoritesDeleted, favoritesDeleted };
  }

  /**
   * Delete all telemetry for a specific node.
   * Uses direct DELETE WHERE for optimal performance.
   */
  async deleteTelemetryByNode(nodeNum: number): Promise<number> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const deleted = await db
        .delete(telemetrySqlite)
        .where(eq(telemetrySqlite.nodeNum, nodeNum))
        .returning({ id: telemetrySqlite.id });
      return deleted.length;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      // MySQL doesn't support .returning(), so count first
      const countResult = await db
        .select({ id: telemetryMysql.id })
        .from(telemetryMysql)
        .where(eq(telemetryMysql.nodeNum, nodeNum));
      const count = countResult.length;
      await db.delete(telemetryMysql).where(eq(telemetryMysql.nodeNum, nodeNum));
      return count;
    } else {
      const db = this.getPostgresDb();
      const deleted = await db
        .delete(telemetryPostgres)
        .where(eq(telemetryPostgres.nodeNum, nodeNum))
        .returning({ id: telemetryPostgres.id });
      return deleted.length;
    }
  }

  /**
   * Delete all telemetry
   */
  async deleteAllTelemetry(): Promise<number> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const count = await db
        .select({ id: telemetrySqlite.id })
        .from(telemetrySqlite);
      await db.delete(telemetrySqlite);
      return count.length;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const count = await db
        .select({ id: telemetryMysql.id })
        .from(telemetryMysql);
      await db.delete(telemetryMysql);
      return count.length;
    } else {
      const db = this.getPostgresDb();
      const count = await db
        .select({ id: telemetryPostgres.id })
        .from(telemetryPostgres);
      await db.delete(telemetryPostgres);
      return count.length;
    }
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

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db
        .selectDistinct({ nodeId: telemetrySqlite.nodeId, type: telemetrySqlite.telemetryType })
        .from(telemetrySqlite);

      for (const r of result) {
        const types = map.get(r.nodeId) || [];
        if (!types.includes(r.type)) {
          types.push(r.type);
        }
        map.set(r.nodeId, types);
      }
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db
        .selectDistinct({ nodeId: telemetryMysql.nodeId, type: telemetryMysql.telemetryType })
        .from(telemetryMysql);

      for (const r of result) {
        const types = map.get(r.nodeId) || [];
        if (!types.includes(r.type)) {
          types.push(r.type);
        }
        map.set(r.nodeId, types);
      }
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .selectDistinct({ nodeId: telemetryPostgres.nodeId, type: telemetryPostgres.telemetryType })
        .from(telemetryPostgres);

      for (const r of result) {
        const types = map.get(r.nodeId) || [];
        if (!types.includes(r.type)) {
          types.push(r.type);
        }
        map.set(r.nodeId, types);
      }
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
