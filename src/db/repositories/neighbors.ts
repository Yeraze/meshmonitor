/**
 * Neighbors Repository
 *
 * Handles neighbor info database operations.
 * Supports both SQLite and PostgreSQL through Drizzle ORM.
 */
import { eq, desc } from 'drizzle-orm';
import { neighborInfoSqlite, neighborInfoPostgres } from '../schema/neighbors.js';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType, DbNeighborInfo } from '../types.js';

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
    } else {
      const db = this.getPostgresDb();
      const count = await db.select().from(neighborInfoPostgres);
      await db.delete(neighborInfoPostgres);
      return count.length;
    }
  }
}
