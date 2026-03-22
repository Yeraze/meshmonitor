/**
 * Ignored Nodes Repository
 *
 * Handles persistence of node ignored status independently of the nodes table.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq } from 'drizzle-orm';
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
    const { ignoredNodes } = this.tables;
    const setData = {
      nodeId,
      longName: longName ?? null,
      shortName: shortName ?? null,
      ignoredAt: now,
      ignoredBy: ignoredBy ?? null,
    };

    if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db
        .insert(ignoredNodes)
        .values({ nodeNum, ...setData })
        .onDuplicateKeyUpdate({ set: setData });
    } else {
      // SQLite and PostgreSQL both use onConflictDoUpdate
      await (this.db as any)
        .insert(ignoredNodes)
        .values({ nodeNum, ...setData })
        .onConflictDoUpdate({
          target: ignoredNodes.nodeNum,
          set: setData,
        });
    }

    logger.debug(`Added node ${nodeNum} (${nodeId}) to persistent ignore list`);
  }

  /**
   * Remove a node from the persistent ignore list
   */
  async removeIgnoredNodeAsync(nodeNum: number): Promise<void> {
    const { ignoredNodes } = this.tables;
    await this.db.delete(ignoredNodes).where(eq(ignoredNodes.nodeNum, nodeNum));
    logger.debug(`Removed node ${nodeNum} from persistent ignore list`);
  }

  /**
   * Get all persistently ignored nodes
   */
  async getIgnoredNodesAsync(): Promise<IgnoredNodeRecord[]> {
    const { ignoredNodes } = this.tables;
    const rows = await this.db.select().from(ignoredNodes);
    return this.normalizeBigInts(rows) as IgnoredNodeRecord[];
  }

  /**
   * Check if a node is in the persistent ignore list
   */
  async isNodeIgnoredAsync(nodeNum: number): Promise<boolean> {
    const { ignoredNodes } = this.tables;
    const rows = await this.db
      .select({ nodeNum: ignoredNodes.nodeNum })
      .from(ignoredNodes)
      .where(eq(ignoredNodes.nodeNum, nodeNum));
    return rows.length > 0;
  }
}
