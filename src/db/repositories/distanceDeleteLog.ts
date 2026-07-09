/**
 * DistanceDeleteLog Repository
 *
 * Handles auto-delete-by-distance log database operations.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, desc } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

export class DistanceDeleteLogRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  // ============ DISTANCE DELETE LOG ============

  /**
   * Get auto-delete-by-distance log entries.
   * If sourceId is provided, scope to that source. NULL sourceId is the
   * legacy/unscoped bucket; an unfiltered call returns all rows.
   */
  async getDistanceDeleteLog(limit: number = 10, sourceId?: string): Promise<any[]> {
    const { autoDistanceDeleteLog } = this.tables;
    const baseQuery = (this.db as any)
      .select()
      .from(autoDistanceDeleteLog);
    const query = sourceId
      ? baseQuery.where(eq(autoDistanceDeleteLog.sourceId, sourceId))
      : baseQuery;
    const rows = await query
      .orderBy(desc(autoDistanceDeleteLog.timestamp))
      .limit(limit);
    return (rows as any[]).map((e: any) => ({
      ...e,
      details: e.details ? JSON.parse(e.details) : [],
    }));
  }

  /**
   * Add an entry to the auto-delete-by-distance log
   */
  async addDistanceDeleteLogEntry(entry: {
    timestamp: number;
    nodesDeleted: number;
    thresholdKm: number;
    details: string;
    sourceId?: string;
  }): Promise<void> {
    const { autoDistanceDeleteLog } = this.tables;
    const now = Date.now();
    await (this.db as any).insert(autoDistanceDeleteLog).values({
      timestamp: entry.timestamp,
      nodesDeleted: entry.nodesDeleted,
      thresholdKm: entry.thresholdKm,
      details: entry.details,
      createdAt: now,
      sourceId: entry.sourceId ?? null,
    });
  }
}
