/**
 * Neighbors Repository
 *
 * Handles neighbor info database operations.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, desc, and, gte, sql } from 'drizzle-orm';
import { neighborInfoSqlite, neighborInfoPostgres, neighborInfoMysql } from '../schema/neighbors.js';
import { packetLogSqlite, packetLogPostgres, packetLogMysql } from '../schema/packets.js';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType, DbNeighborInfo } from '../types.js';

/**
 * Statistics for direct neighbor (zero-hop) packets
 */
export interface DirectNeighborStats {
  nodeNum: number;
  avgRssi: number;
  packetCount: number;
  lastHeard: number;
}

/**
 * Repository for neighbor info operations
 */
export class NeighborsRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  /**
   * Insert or update neighbor info
   */
  async upsertNeighborInfo(neighborData: DbNeighborInfo): Promise<void> {
    const values = {
      nodeNum: neighborData.nodeNum,
      neighborNodeNum: neighborData.neighborNodeNum,
      snr: neighborData.snr ?? null,
      lastRxTime: neighborData.lastRxTime ?? null,
      timestamp: neighborData.timestamp,
      createdAt: neighborData.createdAt,
    };

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db.insert(neighborInfoSqlite).values(values);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db.insert(neighborInfoMysql).values(values);
    } else {
      const db = this.getPostgresDb();
      await db.insert(neighborInfoPostgres).values(values);
    }
  }

  /**
   * Get neighbors for a node
   */
  async getNeighborsForNode(nodeNum: number): Promise<DbNeighborInfo[]> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db
        .select()
        .from(neighborInfoSqlite)
        .where(eq(neighborInfoSqlite.nodeNum, nodeNum))
        .orderBy(desc(neighborInfoSqlite.timestamp));

      return result.map(n => this.normalizeBigInts(n) as DbNeighborInfo);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db
        .select()
        .from(neighborInfoMysql)
        .where(eq(neighborInfoMysql.nodeNum, nodeNum))
        .orderBy(desc(neighborInfoMysql.timestamp));

      return result as DbNeighborInfo[];
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .select()
        .from(neighborInfoPostgres)
        .where(eq(neighborInfoPostgres.nodeNum, nodeNum))
        .orderBy(desc(neighborInfoPostgres.timestamp));

      return result as DbNeighborInfo[];
    }
  }

  /**
   * Get all neighbor info
   */
  async getAllNeighborInfo(): Promise<DbNeighborInfo[]> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db
        .select()
        .from(neighborInfoSqlite)
        .orderBy(desc(neighborInfoSqlite.timestamp));

      return result.map(n => this.normalizeBigInts(n) as DbNeighborInfo);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db
        .select()
        .from(neighborInfoMysql)
        .orderBy(desc(neighborInfoMysql.timestamp));

      return result as DbNeighborInfo[];
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .select()
        .from(neighborInfoPostgres)
        .orderBy(desc(neighborInfoPostgres.timestamp));

      return result as DbNeighborInfo[];
    }
  }

  /**
   * Delete neighbor info for a node
   */
  async deleteNeighborInfoForNode(nodeNum: number): Promise<number> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const toDelete = await db
        .select({ id: neighborInfoSqlite.id })
        .from(neighborInfoSqlite)
        .where(eq(neighborInfoSqlite.nodeNum, nodeNum));

      for (const n of toDelete) {
        await db.delete(neighborInfoSqlite).where(eq(neighborInfoSqlite.id, n.id));
      }
      return toDelete.length;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const toDelete = await db
        .select({ id: neighborInfoMysql.id })
        .from(neighborInfoMysql)
        .where(eq(neighborInfoMysql.nodeNum, nodeNum));

      for (const n of toDelete) {
        await db.delete(neighborInfoMysql).where(eq(neighborInfoMysql.id, n.id));
      }
      return toDelete.length;
    } else {
      const db = this.getPostgresDb();
      const toDelete = await db
        .select({ id: neighborInfoPostgres.id })
        .from(neighborInfoPostgres)
        .where(eq(neighborInfoPostgres.nodeNum, nodeNum));

      for (const n of toDelete) {
        await db.delete(neighborInfoPostgres).where(eq(neighborInfoPostgres.id, n.id));
      }
      return toDelete.length;
    }
  }

  /**
   * Get neighbor count
   */
  async getNeighborCount(): Promise<number> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db.select().from(neighborInfoSqlite);
      return result.length;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db.select().from(neighborInfoMysql);
      return result.length;
    } else {
      const db = this.getPostgresDb();
      const result = await db.select().from(neighborInfoPostgres);
      return result.length;
    }
  }

  /**
   * Delete all neighbor info
   */
  async deleteAllNeighborInfo(): Promise<number> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const count = await db.select().from(neighborInfoSqlite);
      await db.delete(neighborInfoSqlite);
      return count.length;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const count = await db.select().from(neighborInfoMysql);
      await db.delete(neighborInfoMysql);
      return count.length;
    } else {
      const db = this.getPostgresDb();
      const count = await db.select().from(neighborInfoPostgres);
      await db.delete(neighborInfoPostgres);
      return count.length;
    }
  }

  /**
   * Get direct neighbor RSSI statistics from zero-hop packets
   *
   * Queries packet_log for packets received directly (hop_start == hop_limit),
   * aggregating RSSI values to help identify likely relay nodes.
   *
   * @param hoursBack Number of hours to look back (default 24)
   * @returns Map of nodeNum to DirectNeighborStats
   */
  async getDirectNeighborRssiAsync(hoursBack: number = 24): Promise<Map<number, DirectNeighborStats>> {
    const cutoffTime = Math.floor(Date.now() / 1000) - (hoursBack * 60 * 60);
    const result = new Map<number, DirectNeighborStats>();

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      // Query for zero-hop packets (hop_start == hop_limit means 0 hops)
      // Only include packets with valid RSSI
      const rows = await db
        .select({
          nodeNum: packetLogSqlite.from_node,
          avgRssi: sql<number>`AVG(${packetLogSqlite.rssi})`,
          packetCount: sql<number>`COUNT(*)`,
          lastHeard: sql<number>`MAX(${packetLogSqlite.timestamp})`,
        })
        .from(packetLogSqlite)
        .where(
          and(
            gte(packetLogSqlite.timestamp, cutoffTime),
            sql`${packetLogSqlite.hop_start} = ${packetLogSqlite.hop_limit}`,
            sql`${packetLogSqlite.rssi} IS NOT NULL`,
            sql`${packetLogSqlite.direction} = 'rx'`
          )
        )
        .groupBy(packetLogSqlite.from_node);

      for (const row of rows) {
        result.set(Number(row.nodeNum), {
          nodeNum: Number(row.nodeNum),
          avgRssi: row.avgRssi,
          packetCount: row.packetCount,
          lastHeard: row.lastHeard,
        });
      }
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const rows = await db
        .select({
          nodeNum: packetLogMysql.from_node,
          avgRssi: sql<number>`AVG(${packetLogMysql.rssi})`,
          packetCount: sql<number>`COUNT(*)`,
          lastHeard: sql<number>`MAX(${packetLogMysql.timestamp})`,
        })
        .from(packetLogMysql)
        .where(
          and(
            gte(packetLogMysql.timestamp, cutoffTime),
            sql`${packetLogMysql.hop_start} = ${packetLogMysql.hop_limit}`,
            sql`${packetLogMysql.rssi} IS NOT NULL`,
            sql`${packetLogMysql.direction} = 'rx'`
          )
        )
        .groupBy(packetLogMysql.from_node);

      for (const row of rows) {
        result.set(Number(row.nodeNum), {
          nodeNum: Number(row.nodeNum),
          avgRssi: row.avgRssi,
          packetCount: row.packetCount,
          lastHeard: row.lastHeard,
        });
      }
    } else {
      const db = this.getPostgresDb();
      const rows = await db
        .select({
          nodeNum: packetLogPostgres.from_node,
          avgRssi: sql<number>`AVG(${packetLogPostgres.rssi})`,
          packetCount: sql<number>`COUNT(*)`,
          lastHeard: sql<number>`MAX(${packetLogPostgres.timestamp})`,
        })
        .from(packetLogPostgres)
        .where(
          and(
            gte(packetLogPostgres.timestamp, cutoffTime),
            sql`${packetLogPostgres.hop_start} = ${packetLogPostgres.hop_limit}`,
            sql`${packetLogPostgres.rssi} IS NOT NULL`,
            sql`${packetLogPostgres.direction} = 'rx'`
          )
        )
        .groupBy(packetLogPostgres.from_node);

      for (const row of rows) {
        result.set(Number(row.nodeNum), {
          nodeNum: Number(row.nodeNum),
          avgRssi: row.avgRssi,
          packetCount: row.packetCount,
          lastHeard: row.lastHeard,
        });
      }
    }

    return result;
  }
}
