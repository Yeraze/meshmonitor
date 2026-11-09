/**
 * Repository for `meshcore_trace_runs` (issue #6276): an attempt log of the
 * MeshCore traces a source SENT, with their outcome. PER-SOURCE — every read
 * and write takes a `sourceId`.
 *
 * The trace tag is chosen by the manager before the frame goes out, so a row is
 * written as `pending` and completed by `(sourceId, traceTag, authCode)`.
 */
import { and, desc, eq, gte, lt, ne } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

export type MeshCoreTraceRunStatus = 'pending' | 'answered' | 'timeout' | 'failed';
export type MeshCoreTraceRunOrigin = 'manual' | 'schedule' | 'automation' | 'api';

export interface MeshCoreTraceRunRow {
  id?: number;
  sourceId: string;
  traceTag: number;
  authCode: number;
  /** The contact the trace was sent to (full lowercase key), when known. */
  targetPublicKey: string | null;
  /** The hop hashes put on the wire, concatenated hex. */
  pathHex: string;
  hashBytes: number;
  autoReturn: boolean;
  origin: MeshCoreTraceRunOrigin;
  status: MeshCoreTraceRunStatus;
  /** ms since epoch */
  sentAt: number;
  /** ms since epoch; null while pending. */
  completedAt: number | null;
}

export class MeshCoreTraceRunsRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  private requireSource(sourceId: string, op: string): void {
    if (!sourceId) throw new Error(`MeshCoreTraceRunsRepository.${op} requires a sourceId`);
  }

  private toRow(raw: Record<string, unknown>): MeshCoreTraceRunRow {
    const r = this.normalizeBigInts(raw) as Record<string, unknown>;
    return {
      id: Number(r.id),
      sourceId: String(r.sourceId),
      traceTag: Number(r.traceTag),
      authCode: Number(r.authCode),
      targetPublicKey: r.targetPublicKey == null ? null : String(r.targetPublicKey),
      pathHex: String(r.pathHex),
      hashBytes: Number(r.hashBytes),
      autoReturn: r.autoReturn === true || r.autoReturn === 1,
      origin: String(r.origin) as MeshCoreTraceRunOrigin,
      status: String(r.status) as MeshCoreTraceRunStatus,
      sentAt: Number(r.sentAt),
      completedAt: r.completedAt == null ? null : Number(r.completedAt),
    };
  }

  /** Record a trace that is about to go out. Always stored as `pending`. */
  async insertPending(row: Omit<MeshCoreTraceRunRow, 'id' | 'status' | 'completedAt'>): Promise<void> {
    this.requireSource(row.sourceId, 'insertPending');
    const t = this.tables.meshcoreTraceRuns;
    await this.db.insert(t).values({
      sourceId: row.sourceId,
      traceTag: row.traceTag,
      authCode: row.authCode,
      targetPublicKey: row.targetPublicKey ? row.targetPublicKey.toLowerCase() : null,
      pathHex: row.pathHex,
      hashBytes: row.hashBytes,
      autoReturn: row.autoReturn,
      origin: row.origin,
      status: 'pending',
      sentAt: row.sentAt,
      completedAt: null,
    });
  }

  /**
   * Settle the pending run with this tag. Returns the rows changed (0 when no
   * pending run matches: it was already settled or swept).
   */
  async complete(
    sourceId: string,
    traceTag: number,
    authCode: number,
    status: Exclude<MeshCoreTraceRunStatus, 'pending'>,
    completedAt: number,
  ): Promise<number> {
    this.requireSource(sourceId, 'complete');
    const t = this.tables.meshcoreTraceRuns;
    const where = and(
      this.withSourceScope(t, sourceId),
      eq(t.traceTag, traceTag),
      eq(t.authCode, authCode),
      eq(t.status, 'pending'),
    );
    const before = await this.db.select({ id: t.id }).from(t).where(where);
    if (before.length === 0) return 0;
    await this.db.update(t).set({ status, completedAt }).where(where);
    return before.length;
  }

  /**
   * Runs sent at or after `sinceMs`, newest first, at most `limit`, excluding
   * runs still in flight (`pending`). One extra row is read so the caller can
   * tell "exactly the cap" from "more than the cap".
   */
  async getForExplorer(sourceId: string, sinceMs: number, limit: number): Promise<{ runs: MeshCoreTraceRunRow[]; truncated: boolean }> {
    this.requireSource(sourceId, 'getForExplorer');
    if (limit <= 0) return { runs: [], truncated: false };
    const t = this.tables.meshcoreTraceRuns;
    const rows = await this.db.select().from(t)
      .where(and(this.withSourceScope(t, sourceId), gte(t.sentAt, sinceMs), ne(t.status, 'pending')))
      .orderBy(desc(t.sentAt), desc(t.id))
      .limit(limit + 1);
    const runs = rows.map((r: Record<string, unknown>) => this.toRow(r));
    return { runs: runs.slice(0, limit), truncated: runs.length > limit };
  }

  /** Mark `pending` runs sent before `cutoffMs` as `timeout`. Returns the rows changed. */
  async sweepStalePending(sourceId: string, cutoffMs: number, now: number): Promise<number> {
    this.requireSource(sourceId, 'sweepStalePending');
    const t = this.tables.meshcoreTraceRuns;
    const where = and(this.withSourceScope(t, sourceId), eq(t.status, 'pending'), lt(t.sentAt, cutoffMs));
    const stale = await this.db.select({ id: t.id }).from(t).where(where);
    if (stale.length === 0) return 0;
    await this.db.update(t).set({ status: 'timeout', completedAt: now }).where(where);
    return stale.length;
  }

  /** Delete the source's runs sent before `cutoffMs` (retention). */
  async deleteOlderThan(sourceId: string, cutoffMs: number): Promise<void> {
    this.requireSource(sourceId, 'deleteOlderThan');
    const t = this.tables.meshcoreTraceRuns;
    await this.db.delete(t).where(and(this.withSourceScope(t, sourceId), lt(t.sentAt, cutoffMs)));
  }

  /** Delete every run of the source (source deletion). */
  async deleteBySourceId(sourceId: string): Promise<void> {
    this.requireSource(sourceId, 'deleteBySourceId');
    const t = this.tables.meshcoreTraceRuns;
    await this.db.delete(t).where(this.withSourceScope(t, sourceId));
  }
}
