/**
 * Ignored Nodes Repository
 *
 * Handles persistence of node ignored status independently of the nodes table.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq } from 'drizzle-orm';
import { ignoredNodesSqlite, ignoredNodesPostgres, ignoredNodesMysql } from '../schema/ignoredNodes.js';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';
import { logger } from '../../utils/logger.js';

export interface IgnoredNodeRecord {
  nodeNum: number;
  nodeId: string;
  longName: string | null;
  shortName: string | null;
  ignoredAt: number;
  ignoredBy: string | null;
}

/**
 * Repository for ignored nodes operations
 */
export class IgnoredNodesRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  /**
   * Add a node to the persistent ignore list (upsert)
   */
  async addIgnoredNodeAsync(
    nodeNum: number,
    nodeId: string,
    longName?: string | null,
    shortName?: string | null,
    ignoredBy?: string | null,
  ): Promise<void> {
    const now = Date.now();

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      // SQLite upsert via INSERT OR REPLACE
      await db
        .insert(ignoredNodesSqlite)
        .values({
          nodeNum,
          nodeId,
          longName: longName ?? null,
          shortName: shortName ?? null,
          ignoredAt: now,
          ignoredBy: ignoredBy ?? null,
        })
        .onConflictDoUpdate({
          target: ignoredNodesSqlite.nodeNum,
          set: {
            nodeId,
            longName: longName ?? null,
            shortName: shortName ?? null,
            ignoredAt: now,
            ignoredBy: ignoredBy ?? null,
          },
        });
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db
        .insert(ignoredNodesMysql)
        .values({
          nodeNum,
          nodeId,
          longName: longName ?? null,
          shortName: shortName ?? null,
          ignoredAt: now,
          ignoredBy: ignoredBy ?? null,
        })
        .onDuplicateKeyUpdate({
          set: {
            nodeId,
            longName: longName ?? null,
            shortName: shortName ?? null,
            ignoredAt: now,
            ignoredBy: ignoredBy ?? null,
          },
        });
    } else {
      const db = this.getPostgresDb();
      await db
        .insert(ignoredNodesPostgres)
        .values({
          nodeNum,
          nodeId,
          longName: longName ?? null,
          shortName: shortName ?? null,
          ignoredAt: now,
          ignoredBy: ignoredBy ?? null,
        })
        .onConflictDoUpdate({
          target: ignoredNodesPostgres.nodeNum,
          set: {
            nodeId,
            longName: longName ?? null,
            shortName: shortName ?? null,
            ignoredAt: now,
            ignoredBy: ignoredBy ?? null,
          },
        });
    }

    logger.debug(`Added node ${nodeNum} (${nodeId}) to persistent ignore list`);
  }

  /**
   * Remove a node from the persistent ignore list
   */
  async removeIgnoredNodeAsync(nodeNum: number): Promise<void> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db.delete(ignoredNodesSqlite).where(eq(ignoredNodesSqlite.nodeNum, nodeNum));
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db.delete(ignoredNodesMysql).where(eq(ignoredNodesMysql.nodeNum, nodeNum));
    } else {
      const db = this.getPostgresDb();
      await db.delete(ignoredNodesPostgres).where(eq(ignoredNodesPostgres.nodeNum, nodeNum));
    }

    logger.debug(`Removed node ${nodeNum} from persistent ignore list`);
  }

  /**
   * Get all persistently ignored nodes
   */
  async getIgnoredNodesAsync(): Promise<IgnoredNodeRecord[]> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const rows = await db.select().from(ignoredNodesSqlite);
      return rows.map(r => this.normalizeBigInts(r) as IgnoredNodeRecord);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const rows = await db.select().from(ignoredNodesMysql);
      return rows.map(r => this.normalizeBigInts(r) as IgnoredNodeRecord);
    } else {
      const db = this.getPostgresDb();
      const rows = await db.select().from(ignoredNodesPostgres);
      return rows.map(r => this.normalizeBigInts(r) as IgnoredNodeRecord);
    }
  }

  /**
   * Check if a node is in the persistent ignore list
   */
  async isNodeIgnoredAsync(nodeNum: number): Promise<boolean> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const rows = await db
        .select({ nodeNum: ignoredNodesSqlite.nodeNum })
        .from(ignoredNodesSqlite)
        .where(eq(ignoredNodesSqlite.nodeNum, nodeNum));
      return rows.length > 0;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const rows = await db
        .select({ nodeNum: ignoredNodesMysql.nodeNum })
        .from(ignoredNodesMysql)
        .where(eq(ignoredNodesMysql.nodeNum, nodeNum));
      return rows.length > 0;
    } else {
      const db = this.getPostgresDb();
      const rows = await db
        .select({ nodeNum: ignoredNodesPostgres.nodeNum })
        .from(ignoredNodesPostgres)
        .where(eq(ignoredNodesPostgres.nodeNum, nodeNum));
      return rows.length > 0;
    }
  }
}
