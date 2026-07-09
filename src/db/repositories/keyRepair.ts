/**
 * Key Repair Repository
 *
 * Handles auto key repair state and log database operations.
 * All methods are async, dialect-agnostic Drizzle query-builder calls
 * that work identically on SQLite, PostgreSQL, and MySQL.
 *
 * Task 3.2: ported from raw PG/MySQL SQL in database.ts facade to a single
 * Drizzle-based implementation here. Schema parity confirmed on all three
 * backends via migrations 001/008/027 — no new migration needed.
 */
import { eq, desc, and, or, isNull, notInArray } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

export class KeyRepairRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  // =============================================================================
  // Key Repair State — async, 3-backend Drizzle
  // =============================================================================

  /**
   * Fetch key repair state for a node. Returns null if no row exists.
   */
  async getKeyRepairStateAsync(nodeNum: number): Promise<{
    nodeNum: number;
    attemptCount: number;
    lastAttemptTime: number | null;
    exhausted: boolean;
    startedAt: number;
  } | null> {
    const t = this.tables.autoKeyRepairState;
    const rows = await this.db
      .select({
        nodeNum: t.nodeNum,
        attemptCount: t.attemptCount,
        lastAttemptTime: t.lastAttemptTime,
        exhausted: t.exhausted,
        startedAt: t.startedAt,
      })
      .from(t)
      .where(eq(t.nodeNum, nodeNum))
      .limit(1);
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      nodeNum: Number(r.nodeNum),
      attemptCount: Number(r.attemptCount ?? 0),
      lastAttemptTime: r.lastAttemptTime != null ? Number(r.lastAttemptTime) : null,
      // exhausted is integer 0/1 on all three backends (not a boolean column)
      exhausted: Number(r.exhausted) === 1,
      startedAt: Number(r.startedAt),
    };
  }

  /**
   * Upsert key repair state for a node (read-then-write; avoids onConflict
   * dialect divergence between SQLite/PG and MySQL).
   */
  async setKeyRepairStateAsync(
    nodeNum: number,
    state: {
      attemptCount?: number;
      lastAttemptTime?: number;
      exhausted?: boolean;
      startedAt?: number;
    },
  ): Promise<void> {
    const t = this.tables.autoKeyRepairState;
    const existing = await this.getKeyRepairStateAsync(nodeNum);
    const now = Date.now();

    if (existing) {
      await this.db
        .update(t)
        .set({
          attemptCount: state.attemptCount ?? existing.attemptCount,
          lastAttemptTime: state.lastAttemptTime ?? existing.lastAttemptTime,
          exhausted: (state.exhausted ?? existing.exhausted) ? 1 : 0,
        })
        .where(eq(t.nodeNum, nodeNum));
    } else {
      await this.db.insert(t).values({
        nodeNum,
        attemptCount: state.attemptCount ?? 0,
        lastAttemptTime: state.lastAttemptTime ?? null,
        exhausted: (state.exhausted ?? false) ? 1 : 0,
        startedAt: state.startedAt ?? now,
      });
    }
  }

  /**
   * Delete key repair state for a node.
   */
  async clearKeyRepairStateAsync(nodeNum: number): Promise<void> {
    const t = this.tables.autoKeyRepairState;
    await this.db.delete(t).where(eq(t.nodeNum, nodeNum));
  }

  // =============================================================================
  // Key Repair Log — async, 3-backend Drizzle
  // =============================================================================

  /**
   * Return nodes that have keyMismatchDetected=true and are not exhausted.
   * Uses a LEFT JOIN so nodes with no state row are included (exhausted defaults 0).
   * Pushes the exhausted filter into SQL (previously post-filtered in JS for SQLite).
   */
  async getNodesNeedingKeyRepairAsync(): Promise<Array<{
    nodeNum: number;
    nodeId: string;
    longName: string | null;
    shortName: string | null;
    attemptCount: number;
    lastAttemptTime: number | null;
    startedAt: number | null;
  }>> {
    const n = this.tables.nodes;
    const s = this.tables.autoKeyRepairState;
    const rows = await this.db
      .select({
        nodeNum: n.nodeNum,
        nodeId: n.nodeId,
        longName: n.longName,
        shortName: n.shortName,
        attemptCount: s.attemptCount,
        lastAttemptTime: s.lastAttemptTime,
        startedAt: s.startedAt,
      })
      .from(n)
      .leftJoin(s, eq(n.nodeNum, s.nodeNum))
      .where(
        and(
          eq(n.keyMismatchDetected, true),
          or(isNull(s.exhausted), eq(s.exhausted, 0)),
        ),
      );
    return (rows as any[]).map(r => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
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
   * Append a row to the key repair log and trim to the latest 100 rows.
   *
   * Retention is non-transactional (matching prior behavior). A concurrent
   * insert between the SELECT-100 and DELETE-not-in could momentarily leave
   * 101 rows; this is benign.
   *
   * The two-step pattern (select ids → delete notInArray) is used instead of
   * a subquery delete because MySQL cannot reference the delete target table
   * in an uncorrelated subquery. The guard on keep.length avoids the invalid
   * `NOT IN ()` expression that some dialects reject.
   *
   * Returns the inserted row id.
   */
  async logKeyRepairAttemptAsync(
    nodeNum: number,
    nodeName: string | null,
    action: string,
    success: boolean | null,
    oldKeyFragment: string | null,
    newKeyFragment: string | null,
    sourceId: string | null,
  ): Promise<number> {
    const t = this.tables.autoKeyRepairLog;
    const now = Date.now();

    let insertedId: number;

    if (this.dbType === 'mysql') {
      // MySQL does not support .returning(); use insertId from ResultSetHeader
      const result = await this.db.insert(t).values({
        timestamp: now,
        nodeNum,
        nodeName,
        action,
        success: success === null ? null : (success ? 1 : 0),
        createdAt: now,
        oldKeyFragment,
        newKeyFragment,
        sourceId,
      });
      insertedId = Number((result as any)[0]?.insertId ?? 0);
    } else {
      // SQLite and PostgreSQL both support .returning()
      const rows = await this.db
        .insert(t)
        .values({
          timestamp: now,
          nodeNum,
          nodeName,
          action,
          success: success === null ? null : (success ? 1 : 0),
          createdAt: now,
          oldKeyFragment,
          newKeyFragment,
          sourceId,
        })
        .returning({ id: t.id });
      insertedId = Number(rows[0]?.id ?? 0);
    }

    // Retention trim: keep latest 100 rows (non-transactional, see note above)
    const keep = await this.db
      .select({ id: t.id })
      .from(t)
      .orderBy(desc(t.timestamp))
      .limit(100);
    // Guard: notInArray(col, []) is invalid SQL in some dialects; after a
    // successful INSERT keep.length >= 1, but guard defensively.
    if (keep.length > 0) {
      await this.db
        .delete(t)
        .where(notInArray(t.id, (keep as any[]).map(r => Number(r.id)))); // eslint-disable-line @typescript-eslint/no-explicit-any
    }

    return insertedId;
  }

  /**
   * Fetch key repair log rows, newest-first, with optional sourceId filter.
   * Returns fragment columns (always available after migration 008).
   */
  async getKeyRepairLogAsync(limit: number, sourceId?: string): Promise<Array<{
    id: number;
    timestamp: number;
    nodeNum: number;
    nodeName: string | null;
    action: string;
    success: boolean | null;
    oldKeyFragment: string | null;
    newKeyFragment: string | null;
  }>> {
    const t = this.tables.autoKeyRepairLog;
    const rows = await this.db
      .select({
        id: t.id,
        timestamp: t.timestamp,
        nodeNum: t.nodeNum,
        nodeName: t.nodeName,
        action: t.action,
        success: t.success,
        oldKeyFragment: t.oldKeyFragment,
        newKeyFragment: t.newKeyFragment,
      })
      .from(t)
      .where(sourceId ? eq(t.sourceId, sourceId) : undefined)
      .orderBy(desc(t.timestamp))
      .limit(limit);
    return (rows as any[]).map(r => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
      id: Number(r.id),
      timestamp: Number(r.timestamp),
      nodeNum: Number(r.nodeNum),
      nodeName: r.nodeName ?? null,
      action: r.action,
      success: r.success === null || r.success === undefined ? null : Boolean(r.success),
      oldKeyFragment: r.oldKeyFragment ?? null,
      newKeyFragment: r.newKeyFragment ?? null,
    }));
  }
}
