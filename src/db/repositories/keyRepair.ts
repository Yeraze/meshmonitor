/**
 * Key Repair Repository
 *
 * Handles auto key repair state and log database operations.
 * All methods are SQLite-only sync variants; async multi-dialect parity
 * is owned by Task 3.2.
 */
import { eq } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

export class KeyRepairRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  // =============================================================================
  // Key Repair State / Log — SQLite sync variants
  // (async multi-dialect versions still live on DatabaseService for now)
  // =============================================================================

  /**
   * SQLite-only sync fetch of key repair state.
   */
  getKeyRepairStateSqlite(nodeNum: number): {
    nodeNum: number;
    attemptCount: number;
    lastAttemptTime: number | null;
    exhausted: boolean;
    startedAt: number;
  } | null {
    if (!this.sqliteDb) throw new Error('getKeyRepairStateSqlite is SQLite-only');
    const db = this.sqliteDb;
    const t = (this.tables as any).autoKeyRepairState;
    const rows = db
      .select({
        nodeNum: t.nodeNum,
        attemptCount: t.attemptCount,
        lastAttemptTime: t.lastAttemptTime,
        exhausted: t.exhausted,
        startedAt: t.startedAt,
      })
      .from(t)
      .where(eq(t.nodeNum, nodeNum))
      .limit(1)
      .all() as Array<{
        nodeNum: number;
        attemptCount: number;
        lastAttemptTime: number | null;
        exhausted: number;
        startedAt: number;
      }>;
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      nodeNum: Number(r.nodeNum),
      attemptCount: Number(r.attemptCount ?? 0),
      lastAttemptTime: r.lastAttemptTime != null ? Number(r.lastAttemptTime) : null,
      exhausted: Number(r.exhausted) === 1,
      startedAt: Number(r.startedAt),
    };
  }

  /**
   * SQLite-only sync upsert of key repair state (mirrors legacy facade logic).
   */
  setKeyRepairStateSqlite(
    nodeNum: number,
    state: { attemptCount?: number; lastAttemptTime?: number; exhausted?: boolean; startedAt?: number },
    existing: { attemptCount: number; lastAttemptTime: number | null; exhausted: boolean } | null,
  ): void {
    if (!this.sqliteDb) throw new Error('setKeyRepairStateSqlite is SQLite-only');
    const db = this.sqliteDb;
    const t = (this.tables as any).autoKeyRepairState;
    const now = Date.now();

    if (existing) {
      db.update(t)
        .set({
          attemptCount: state.attemptCount ?? existing.attemptCount,
          lastAttemptTime: state.lastAttemptTime ?? existing.lastAttemptTime,
          exhausted: (state.exhausted ?? existing.exhausted) ? 1 : 0,
        })
        .where(eq(t.nodeNum, nodeNum))
        .run();
    } else {
      db.insert(t).values({
        nodeNum,
        attemptCount: state.attemptCount ?? 0,
        lastAttemptTime: state.lastAttemptTime ?? null,
        exhausted: (state.exhausted ?? false) ? 1 : 0,
        startedAt: state.startedAt ?? now,
      }).run();
    }
  }

  /**
   * SQLite-only sync delete of key repair state.
   */
  clearKeyRepairStateSqlite(nodeNum: number): void {
    if (!this.sqliteDb) throw new Error('clearKeyRepairStateSqlite is SQLite-only');
    const db = this.sqliteDb;
    const t = (this.tables as any).autoKeyRepairState;
    db.delete(t).where(eq(t.nodeNum, nodeNum)).run();
  }

  /**
   * SQLite-only sync list of nodes needing key repair — joins the nodes table
   * to pick up nodeId/longName/shortName.
   */
  getNodesNeedingKeyRepairSqlite(): Array<{
    nodeNum: number;
    nodeId: string;
    longName: string | null;
    shortName: string | null;
    attemptCount: number;
    lastAttemptTime: number | null;
    startedAt: number | null;
  }> {
    if (!this.sqliteDb) throw new Error('getNodesNeedingKeyRepairSqlite is SQLite-only');
    const db = this.sqliteDb;
    const n = (this.tables as any).nodes;
    const s = (this.tables as any).autoKeyRepairState;
    // Drizzle's leftJoin sugar
    const rows = db
      .select({
        nodeNum: n.nodeNum,
        nodeId: n.nodeId,
        longName: n.longName,
        shortName: n.shortName,
        attemptCount: s.attemptCount,
        lastAttemptTime: s.lastAttemptTime,
        startedAt: s.startedAt,
        exhausted: s.exhausted,
      })
      .from(n)
      .leftJoin(s, eq(n.nodeNum, s.nodeNum))
      .where(eq(n.keyMismatchDetected, true))
      .all() as any[];
    return rows
      .filter(r => r.exhausted == null || Number(r.exhausted) === 0)
      .map(r => ({
        nodeNum: Number(r.nodeNum),
        nodeId: r.nodeId,
        longName: r.longName ?? null,
        shortName: r.shortName ?? null,
        attemptCount: Number(r.attemptCount ?? 0),
        lastAttemptTime: r.lastAttemptTime != null ? Number(r.lastAttemptTime) : null,
        startedAt: r.startedAt != null ? Number(r.startedAt) : null,
      }));
  }

  /**
   * SQLite-only sync append to key repair log + cleanup.
   * Uses the full v084 column set (oldKeyFragment, newKeyFragment, sourceId).
   * The schema's SQLite table only includes timestamp/nodeNum/nodeName/action/success
   * etc.; for the extended columns we drop down to raw SQL at a tagged site
   * (this repo doesn't know about columns added via migrations at runtime).
   */
  logKeyRepairAttemptSqlite(
    nodeNum: number,
    nodeName: string | null,
    action: string,
    success: boolean | null,
    oldKeyFragment: string | null,
    newKeyFragment: string | null,
    sourceId: string | null,
  ): number {
    if (!this.sqliteDb) throw new Error('logKeyRepairAttemptSqlite is SQLite-only');
    const betterSqlite = (this.sqliteDb as any).$client as import('better-sqlite3').Database;
    const now = Date.now();
    const info = betterSqlite
      .prepare(`
        INSERT INTO auto_key_repair_log (timestamp, nodeNum, nodeName, action, success, created_at, oldKeyFragment, newKeyFragment, sourceId)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(now, nodeNum, nodeName, action, success === null ? null : (success ? 1 : 0), now, oldKeyFragment, newKeyFragment, sourceId);
    betterSqlite
      .prepare('DELETE FROM auto_key_repair_log WHERE id NOT IN (SELECT id FROM auto_key_repair_log ORDER BY timestamp DESC LIMIT 100)')
      .run();
    return Number(info.lastInsertRowid);
  }

  /**
   * SQLite-only — probe introspection used by getKeyRepairLogAsync fallback.
   * Returns an object describing column / table presence so the caller can
   * build the correct SELECT list without raw SQL on the facade.
   */
  getKeyRepairLogIntrospectionSqlite(): { tableExists: boolean; hasOldKeyCol: boolean; hasSourceId: boolean } {
    if (!this.sqliteDb) throw new Error('getKeyRepairLogIntrospectionSqlite is SQLite-only');
    const betterSqlite = (this.sqliteDb as any).$client as import('better-sqlite3').Database;
    try {
      const table = betterSqlite
        .prepare("SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name='auto_key_repair_log'")
        .get() as { count: number };
      if (table.count === 0) return { tableExists: false, hasOldKeyCol: false, hasSourceId: false };
      const oldKey = betterSqlite
        .prepare("SELECT COUNT(*) as count FROM pragma_table_info('auto_key_repair_log') WHERE name='oldKeyFragment'")
        .get() as { count: number };
      const src = betterSqlite
        .prepare("SELECT COUNT(*) as count FROM pragma_table_info('auto_key_repair_log') WHERE name='sourceId'")
        .get() as { count: number };
      return { tableExists: true, hasOldKeyCol: oldKey.count > 0, hasSourceId: src.count > 0 };
    } catch {
      return { tableExists: false, hasOldKeyCol: false, hasSourceId: false };
    }
  }

  /**
   * SQLite-only — fetch key repair log rows with optional sourceId filter.
   * Assumes introspection has already confirmed the table and columns exist.
   */
  getKeyRepairLogSqlite(limit: number, sourceId: string | undefined, hasOldKeyCol: boolean, hasSourceId: boolean): Array<{
    id: number;
    timestamp: number;
    nodeNum: number;
    nodeName: string | null;
    action: string;
    success: boolean | null;
    oldKeyFragment: string | null;
    newKeyFragment: string | null;
  }> {
    if (!this.sqliteDb) throw new Error('getKeyRepairLogSqlite is SQLite-only');
    const betterSqlite = (this.sqliteDb as any).$client as import('better-sqlite3').Database;
    const selectCols = hasOldKeyCol
      ? 'id, timestamp, nodeNum, nodeName, action, success, oldKeyFragment, newKeyFragment'
      : 'id, timestamp, nodeNum, nodeName, action, success';
    const useSourceFilter = !!sourceId && hasSourceId;
    const whereClause = useSourceFilter ? 'WHERE sourceId = ?' : '';
    const params: any[] = useSourceFilter ? [sourceId, limit] : [limit];
    const rows = betterSqlite
      .prepare(`SELECT ${selectCols} FROM auto_key_repair_log ${whereClause} ORDER BY timestamp DESC LIMIT ?`)
      .all(...params) as any[];
    return rows.map(row => ({
      id: row.id,
      timestamp: Number(row.timestamp),
      nodeNum: Number(row.nodeNum),
      nodeName: row.nodeName,
      action: row.action,
      success: row.success === null ? null : Boolean(row.success),
      oldKeyFragment: row.oldKeyFragment || null,
      newKeyFragment: row.newKeyFragment || null,
    }));
  }
}
