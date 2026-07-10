/**
 * AutoTraceroute Repository
 *
 * Handles auto-traceroute node list and log database operations.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, asc, desc, and, isNull, notInArray, sql } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';
import { logger } from '../../utils/logger.js';

export interface AutoTracerouteNode {
  id?: number;
  nodeNum: number;
  enabled?: boolean;
  createdAt: number;
}

export class AutoTracerouteRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  // ============ AUTO-TRACEROUTE NODES ============

  /**
   * Get all auto-traceroute nodes.
   * When sourceId is provided, return only rows scoped to that source OR
   * legacy unscoped rows (sourceId IS NULL). When omitted, return everything.
   */
  async getAutoTracerouteNodes(sourceId?: string): Promise<number[]> {
    const { autoTracerouteNodes } = this.tables;
    const query = this.db
      .select({ nodeNum: autoTracerouteNodes.nodeNum })
      .from(autoTracerouteNodes);
    const results = sourceId
      ? await query
          .where(eq(autoTracerouteNodes.sourceId, sourceId))
          .orderBy(asc(autoTracerouteNodes.createdAt))
      : await query.orderBy(asc(autoTracerouteNodes.createdAt));
    return results.map((r: any) => Number(r.nodeNum));
  }

  /**
   * Set auto-traceroute nodes (replaces all existing entries for the given
   * source, or globally when sourceId is omitted).
   */
  async setAutoTracerouteNodes(nodeNums: number[], sourceId?: string): Promise<void> {
    const now = this.now();
    const { autoTracerouteNodes } = this.tables;

    // Delete existing entries scoped to this source (or all when unscoped).
    if (sourceId) {
      await this.db
        .delete(autoTracerouteNodes)
        .where(eq(autoTracerouteNodes.sourceId, sourceId));
    } else {
      await this.db.delete(autoTracerouteNodes);
    }
    // Insert new entries
    for (const nodeNum of nodeNums) {
      await this.db
        .insert(autoTracerouteNodes)
        .values({ nodeNum, createdAt: now, sourceId: sourceId ?? null });
    }
  }

  /**
   * Add a single auto-traceroute node.
   * Keeps branching: MySQL lacks onConflictDoNothing.
   */
  async addAutoTracerouteNode(nodeNum: number, sourceId?: string): Promise<void> {
    const now = this.now();
    const { autoTracerouteNodes } = this.tables;

    // Pre-check for the (nodeNum, sourceId) tuple. Needed because SQLite/MySQL
    // treat NULL as distinct in UNIQUE constraints, so insertIgnore would
    // allow duplicate unscoped rows.
    const whereClause = sourceId
      ? and(eq(autoTracerouteNodes.nodeNum, nodeNum), eq(autoTracerouteNodes.sourceId, sourceId))
      : and(eq(autoTracerouteNodes.nodeNum, nodeNum), isNull(autoTracerouteNodes.sourceId));
    const existing = await this.db
      .select({ id: autoTracerouteNodes.id })
      .from(autoTracerouteNodes)
      .where(whereClause)
      .limit(1);
    if (existing.length > 0) return;

    await this.insertIgnore(autoTracerouteNodes, {
      nodeNum,
      createdAt: now,
      sourceId: sourceId ?? null,
    });
  }

  /**
   * Remove a single auto-traceroute node
   */
  async removeAutoTracerouteNode(nodeNum: number, sourceId?: string): Promise<void> {
    const { autoTracerouteNodes } = this.tables;
    const where = sourceId
      ? and(
          eq(autoTracerouteNodes.nodeNum, nodeNum),
          eq(autoTracerouteNodes.sourceId, sourceId)
        )
      : eq(autoTracerouteNodes.nodeNum, nodeNum);
    await this.db.delete(autoTracerouteNodes).where(where);
  }

  // ============ auto_traceroute_log async methods (all backends) ============

  /**
   * Get the most recent auto-traceroute log rows (all backends).
   * Boolean success is returned (null preserved).
   */
  async getAutoTracerouteLog(limit: number = 10, sourceId?: string): Promise<Array<{
    id: number;
    timestamp: number;
    toNodeNum: number;
    toNodeName: string | null;
    success: boolean | null;
  }>> {
    try {
      const { autoTracerouteLog } = this.tables;
      const query = this.db
        .select({
          id: autoTracerouteLog.id,
          timestamp: autoTracerouteLog.timestamp,
          toNodeNum: autoTracerouteLog.toNodeNum,
          toNodeName: autoTracerouteLog.toNodeName,
          success: autoTracerouteLog.success,
        })
        .from(autoTracerouteLog);
      const scoped = sourceId !== undefined
        ? query.where(eq(autoTracerouteLog.sourceId, sourceId))
        : query;
      const rows = await scoped
        .orderBy(desc(autoTracerouteLog.timestamp))
        .limit(limit);
      return (rows as any[]).map((r: any) => ({
        id: Number(r.id),
        timestamp: Number(r.timestamp),
        toNodeNum: Number(r.toNodeNum),
        toNodeName: r.toNodeName ?? null,
        success: r.success === null || r.success === undefined ? null : Boolean(r.success),
      }));
    } catch (error) {
      logger.error(`[AutoTracerouteRepository] Failed to get auto traceroute log: ${error}`);
      return [];
    }
  }

  /**
   * Insert an auto-traceroute attempt row and prune to the last 100 entries.
   * Returns the inserted row id. Works for SQLite/Postgres/MySQL.
   */
  async logAutoTracerouteAttempt(toNodeNum: number, toNodeName: string | null, sourceId?: string): Promise<number> {
    try {
      const { autoTracerouteLog } = this.tables;
      const now = Date.now();
      const values: any = {
        timestamp: now,
        toNodeNum,
        toNodeName,
        success: null,
        createdAt: now,
        sourceId: sourceId ?? null,
      };

      let insertedId = 0;
      if (this.isPostgres()) {
        const result = await (this.db.insert(autoTracerouteLog).values(values) as any).returning({ id: autoTracerouteLog.id });
        insertedId = Number((result as any[])[0]?.id ?? 0);
      } else if (this.isMySQL()) {
        const result = await this.db.insert(autoTracerouteLog).values(values);
        insertedId = Number((result as any)?.[0]?.insertId ?? 0);
      } else {
        const result = await this.db.insert(autoTracerouteLog).values(values);
        insertedId = Number((result as any)?.lastInsertRowid ?? 0);
      }

      // Prune older rows beyond the 100 most recent.
      const keepRows = await this.db
        .select({ id: autoTracerouteLog.id })
        .from(autoTracerouteLog)
        .orderBy(desc(autoTracerouteLog.timestamp))
        .limit(100);
      const keepIds = (keepRows as any[]).map((r) => Number(r.id));
      if (keepIds.length > 0) {
        await this.db
          .delete(autoTracerouteLog)
          .where(notInArray(autoTracerouteLog.id, keepIds));
      }

      return insertedId;
    } catch (error) {
      logger.error(`[AutoTracerouteRepository] Failed to log auto traceroute attempt: ${error}`);
      return 0;
    }
  }

  /**
   * Update the most recent pending auto-traceroute log row for a given
   * destination node across all backends.
   */
  async updateAutoTracerouteResultByNode(toNodeNum: number, success: boolean): Promise<void> {
    try {
      const { autoTracerouteLog } = this.tables;
      const rows = await this.db
        .select({ id: autoTracerouteLog.id })
        .from(autoTracerouteLog)
        .where(and(eq(autoTracerouteLog.toNodeNum, toNodeNum), isNull(autoTracerouteLog.success))!)
        .orderBy(desc(autoTracerouteLog.timestamp))
        .limit(1);
      if ((rows as any[]).length > 0) {
        const id = Number(((rows as any[])[0]).id);
        await this.db
          .update(autoTracerouteLog)
          .set({ success: success ? 1 : 0 } as any)
          .where(eq(autoTracerouteLog.id, id));
      }
    } catch (error) {
      logger.error(`[AutoTracerouteRepository] Failed to update auto traceroute result: ${error}`);
    }
  }

  // ============ auto_traceroute_nodes sync methods (SQLite only) ============



  // ============ auto_traceroute_log sync methods (SQLite only) ============

  /**
   * Synchronously insert an auto-traceroute attempt row and prune to the last
   * 100 entries (SQLite only). Returns the inserted row id.
   */
  logAutoTracerouteAttemptSync(toNodeNum: number, toNodeName: string | null, sourceId?: string): number {
    const db = this.getSqliteDb();
    const { autoTracerouteLog } = this.tables;
    const now = Date.now();
    const result = db
      .insert(autoTracerouteLog)
      .values({
        timestamp: now,
        toNodeNum,
        toNodeName,
        success: null,
        createdAt: now,
        sourceId: sourceId ?? null,
      } as any)
      .run() as any;

    // Prune older rows beyond the 100 most recent.
    const keepRows = db
      .select({ id: autoTracerouteLog.id })
      .from(autoTracerouteLog)
      .orderBy(desc(autoTracerouteLog.timestamp))
      .limit(100)
      .all();
    const keepIds = (keepRows as any[]).map((r) => Number(r.id));
    if (keepIds.length > 0) {
      db.delete(autoTracerouteLog)
        .where(sql`id NOT IN (${sql.join(keepIds.map((id) => sql`${id}`), sql`, `)})`)
        .run();
    }

    return Number(result?.lastInsertRowid ?? 0);
  }


  /**
   * Synchronously update the most recent pending auto-traceroute log row for
   * a given destination node (SQLite only).
   */
  updateAutoTracerouteResultByNodeSync(toNodeNum: number, success: boolean): void {
    const db = this.getSqliteDb();
    const { autoTracerouteLog } = this.tables;
    const rows = db
      .select({ id: autoTracerouteLog.id })
      .from(autoTracerouteLog)
      .where(and(eq(autoTracerouteLog.toNodeNum, toNodeNum), isNull(autoTracerouteLog.success))!)
      .orderBy(desc(autoTracerouteLog.timestamp))
      .limit(1)
      .all();
    if (rows.length > 0) {
      const id = Number((rows[0] as any).id);
      db.update(autoTracerouteLog)
        .set({ success: success ? 1 : 0 } as any)
        .where(eq(autoTracerouteLog.id, id))
        .run();
    }
  }

  /**
   * Synchronously fetch the most recent auto-traceroute log rows (SQLite only).
   * Boolean success is returned (null preserved).
   */
  getAutoTracerouteLogSync(limit: number = 10, sourceId?: string): Array<{
    id: number;
    timestamp: number;
    toNodeNum: number;
    toNodeName: string | null;
    success: boolean | null;
  }> {
    const db = this.getSqliteDb();
    const { autoTracerouteLog } = this.tables;
    const query = db
      .select({
        id: autoTracerouteLog.id,
        timestamp: autoTracerouteLog.timestamp,
        toNodeNum: autoTracerouteLog.toNodeNum,
        toNodeName: autoTracerouteLog.toNodeName,
        success: autoTracerouteLog.success,
      })
      .from(autoTracerouteLog);
    const rows = (sourceId !== undefined
      ? query.where(eq(autoTracerouteLog.sourceId, sourceId))
      : query)
      .orderBy(desc(autoTracerouteLog.timestamp))
      .limit(limit)
      .all();
    return (rows as any[]).map((r: any) => ({
      id: Number(r.id),
      timestamp: Number(r.timestamp),
      toNodeNum: Number(r.toNodeNum),
      toNodeName: r.toNodeName ?? null,
      success: r.success === null || r.success === undefined ? null : r.success === 1,
    }));
  }
}
