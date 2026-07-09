/**
 * TimeSync Repository
 *
 * Handles auto time sync node list database operations.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, asc, and } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

export class TimeSyncRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  // ============ AUTO TIME SYNC NODES ============

  /**
   * Get all auto time sync nodes.
   * When sourceId is provided, return only rows scoped to that source.
   * When omitted, return everything.
   */
  async getAutoTimeSyncNodes(sourceId?: string): Promise<number[]> {
    const { autoTimeSyncNodes } = this.tables;
    const query = this.db
      .select({ nodeNum: autoTimeSyncNodes.nodeNum })
      .from(autoTimeSyncNodes);
    const results = sourceId
      ? await query
          .where(eq(autoTimeSyncNodes.sourceId, sourceId))
          .orderBy(asc(autoTimeSyncNodes.createdAt))
      : await query.orderBy(asc(autoTimeSyncNodes.createdAt));
    return results.map((r: any) => Number(r.nodeNum));
  }

  /**
   * Set auto time sync nodes (replaces all existing entries for the given
   * source, or globally when sourceId is omitted).
   */
  async setAutoTimeSyncNodes(nodeNums: number[], sourceId?: string): Promise<void> {
    const now = this.now();
    const { autoTimeSyncNodes } = this.tables;

    // Delete existing entries scoped to this source (or all when unscoped).
    if (sourceId) {
      await this.db
        .delete(autoTimeSyncNodes)
        .where(eq(autoTimeSyncNodes.sourceId, sourceId));
    } else {
      await this.db.delete(autoTimeSyncNodes);
    }
    // Insert new entries
    for (const nodeNum of nodeNums) {
      await this.db
        .insert(autoTimeSyncNodes)
        .values({ nodeNum, createdAt: now, sourceId: sourceId ?? null });
    }
  }

  /**
   * Add a single auto time sync node.
   * Keeps branching: MySQL lacks onConflictDoNothing.
   */
  async addAutoTimeSyncNode(nodeNum: number, sourceId?: string): Promise<void> {
    const now = this.now();
    const { autoTimeSyncNodes } = this.tables;

    await this.insertIgnore(autoTimeSyncNodes, {
      nodeNum,
      createdAt: now,
      sourceId: sourceId ?? null,
    });
  }

  /**
   * Remove a single auto time sync node
   */
  async removeAutoTimeSyncNode(nodeNum: number, sourceId?: string): Promise<void> {
    const { autoTimeSyncNodes } = this.tables;
    const where = sourceId
      ? and(
          eq(autoTimeSyncNodes.nodeNum, nodeNum),
          eq(autoTimeSyncNodes.sourceId, sourceId)
        )
      : eq(autoTimeSyncNodes.nodeNum, nodeNum);
    await this.db.delete(autoTimeSyncNodes).where(where);
  }
}
