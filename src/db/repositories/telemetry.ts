/**
 * Telemetry Repository
 *
 * Handles all telemetry-related database operations.
 * Supports both SQLite and PostgreSQL through Drizzle ORM.
 */
import { eq, lt, gte, and, desc, inArray } from 'drizzle-orm';
import { telemetrySqlite, telemetryPostgres } from '../schema/telemetry.js';
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
      channel: telemetryData.channel ?? null,
      precisionBits: telemetryData.precisionBits ?? null,
      gpsAccuracy: telemetryData.gpsAccuracy ?? null,
    };

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db.insert(telemetrySqlite).values(values);
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
   * Get position telemetry (latitude, longitude, altitude) for a node
   */
  async getPositionTelemetryByNode(
    nodeId: string,
    limit: number = 1500,
    sinceTimestamp?: number
  ): Promise<DbTelemetry[]> {
    const positionTypes = ['latitude', 'longitude', 'altitude'];

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
   * Delete telemetry by node and type
   */
  async deleteTelemetryByNodeAndType(nodeId: string, telemetryType: string): Promise<boolean> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const toDelete = await db
        .select({ id: telemetrySqlite.id })
        .from(telemetrySqlite)
        .where(
          and(
            eq(telemetrySqlite.nodeId, nodeId),
            eq(telemetrySqlite.telemetryType, telemetryType)
          )
        );

      if (toDelete.length === 0) return false;

      for (const record of toDelete) {
        await db.delete(telemetrySqlite).where(eq(telemetrySqlite.id, record.id));
      }
      return true;
    } else {
      const db = this.getPostgresDb();
      const toDelete = await db
        .select({ id: telemetryPostgres.id })
        .from(telemetryPostgres)
        .where(
          and(
            eq(telemetryPostgres.nodeId, nodeId),
            eq(telemetryPostgres.telemetryType, telemetryType)
          )
        );

      if (toDelete.length === 0) return false;

      for (const record of toDelete) {
        await db.delete(telemetryPostgres).where(eq(telemetryPostgres.id, record.id));
      }
      return true;
    }
  }

  /**
   * Purge telemetry for a node
   */
  async purgeNodeTelemetry(nodeNum: number): Promise<number> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const toDelete = await db
        .select({ id: telemetrySqlite.id })
        .from(telemetrySqlite)
        .where(eq(telemetrySqlite.nodeNum, nodeNum));

      for (const record of toDelete) {
        await db.delete(telemetrySqlite).where(eq(telemetrySqlite.id, record.id));
      }
      return toDelete.length;
    } else {
      const db = this.getPostgresDb();
      const toDelete = await db
        .select({ id: telemetryPostgres.id })
        .from(telemetryPostgres)
        .where(eq(telemetryPostgres.nodeNum, nodeNum));

      for (const record of toDelete) {
        await db.delete(telemetryPostgres).where(eq(telemetryPostgres.id, record.id));
      }
      return toDelete.length;
    }
  }

  /**
   * Cleanup old telemetry data
   */
  async cleanupOldTelemetry(days: number = 30): Promise<number> {
    const cutoff = this.now() - (days * 24 * 60 * 60 * 1000);

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const toDelete = await db
        .select({ id: telemetrySqlite.id })
        .from(telemetrySqlite)
        .where(lt(telemetrySqlite.timestamp, cutoff));

      for (const record of toDelete) {
        await db.delete(telemetrySqlite).where(eq(telemetrySqlite.id, record.id));
      }
      return toDelete.length;
    } else {
      const db = this.getPostgresDb();
      const toDelete = await db
        .select({ id: telemetryPostgres.id })
        .from(telemetryPostgres)
        .where(lt(telemetryPostgres.timestamp, cutoff));

      for (const record of toDelete) {
        await db.delete(telemetryPostgres).where(eq(telemetryPostgres.id, record.id));
      }
      return toDelete.length;
    }
  }
}
