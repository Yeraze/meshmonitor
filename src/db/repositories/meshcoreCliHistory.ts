/**
 * Repository for `meshcore_cli_history` (issue #5892): one row per MeshCore
 * CLI command a person issued through MeshMonitor.
 *
 * PER-SOURCE — every write takes a `sourceId`, and every read takes the scopes
 * (source + target kinds) the caller may read. Text is redacted by the caller
 * (`recordMeshcoreCliHistory`); this layer only caps its length.
 */
import { and, desc, eq, gte, inArray, lt, lte, or, type SQL } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

export type MeshCoreCliTargetKind = 'local' | 'remote';
export type MeshCoreCliOrigin = 'user' | 'vn';
export type MeshCoreCliOutcome = 'ok' | 'blocked' | 'failed' | 'timeout';

/** Reply / error text kept per row (characters). */
export const CLI_HISTORY_TEXT_CAP = 8192;
/** Command text kept per row (characters). */
export const CLI_HISTORY_COMMAND_CAP = 1024;
export const CLI_HISTORY_DEFAULT_LIMIT = 100;
export const CLI_HISTORY_MAX_LIMIT = 500;

export interface MeshCoreCliHistoryRow {
  id: number;
  sourceId: string;
  /** ms since epoch */
  timestamp: number;
  targetKind: MeshCoreCliTargetKind;
  targetPublicKey: string | null;
  targetName: string | null;
  origin: MeshCoreCliOrigin;
  userId: number | null;
  username: string | null;
  command: string;
  outcome: MeshCoreCliOutcome;
  reply: string | null;
  error: string | null;
  elapsedMs: number | null;
  ipAddress: string | null;
}

export type NewMeshCoreCliHistoryRow = Omit<MeshCoreCliHistoryRow, 'id'>;

/** What one caller may read on one source. */
export interface MeshCoreCliHistoryScope {
  sourceId: string;
  kinds: MeshCoreCliTargetKind[];
}

export interface MeshCoreCliHistoryQuery {
  /** `'all'` (admin) or the per-source scopes the caller may read. */
  scopes: 'all' | MeshCoreCliHistoryScope[];
  /** Restrict to these sources (applied on top of `scopes`). */
  sourceIds?: string[];
  targetKind?: MeshCoreCliTargetKind;
  targetPublicKey?: string;
  /** Exact username match. */
  username?: string;
  /** Inclusive lower bound (ms). */
  from?: number;
  /** Inclusive upper bound (ms). */
  to?: number;
  /** Exclusive cursor: only rows older than this timestamp (ms). */
  before?: number;
  limit?: number;
}

function cap(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export class MeshCoreCliHistoryRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  async record(row: NewMeshCoreCliHistoryRow): Promise<void> {
    if (!row.sourceId) throw new Error('MeshCoreCliHistoryRepository.record requires a sourceId');
    const { meshcoreCliHistory } = this.tables;
    await this.db.insert(meshcoreCliHistory).values({
      sourceId: row.sourceId,
      timestamp: row.timestamp,
      targetKind: row.targetKind,
      targetPublicKey: row.targetPublicKey ? row.targetPublicKey.toLowerCase() : null,
      targetName: cap(row.targetName, 255),
      origin: row.origin,
      userId: row.userId ?? null,
      username: cap(row.username, 255),
      command: cap(row.command, CLI_HISTORY_COMMAND_CAP) ?? '',
      outcome: row.outcome,
      reply: cap(row.reply, CLI_HISTORY_TEXT_CAP),
      error: cap(row.error, CLI_HISTORY_TEXT_CAP),
      elapsedMs: row.elapsedMs === null || row.elapsedMs === undefined ? null : Math.round(row.elapsedMs),
      ipAddress: cap(row.ipAddress, 64),
    });
  }

  /** Newest first. Returns [] when the caller may read nothing. */
  async list(query: MeshCoreCliHistoryQuery): Promise<MeshCoreCliHistoryRow[]> {
    const { meshcoreCliHistory: t } = this.tables;
    const conditions: SQL[] = [];

    if (query.scopes !== 'all') {
      const scopeConds = query.scopes
        .filter(s => s.kinds.length > 0)
        .map(s => and(eq(t.sourceId, s.sourceId), inArray(t.targetKind, s.kinds)) as SQL);
      if (scopeConds.length === 0) return [];
      conditions.push(scopeConds.length === 1 ? scopeConds[0] : (or(...scopeConds) as SQL));
    }
    if (query.sourceIds) {
      if (query.sourceIds.length === 0) return [];
      conditions.push(inArray(t.sourceId, query.sourceIds));
    }
    if (query.targetKind) conditions.push(eq(t.targetKind, query.targetKind));
    if (query.targetPublicKey) conditions.push(eq(t.targetPublicKey, query.targetPublicKey.toLowerCase()));
    if (query.username) conditions.push(eq(t.username, query.username));
    if (query.from !== undefined) conditions.push(gte(t.timestamp, query.from));
    if (query.to !== undefined) conditions.push(lte(t.timestamp, query.to));
    if (query.before !== undefined) conditions.push(lt(t.timestamp, query.before));

    const limit = Math.min(Math.max(1, query.limit ?? CLI_HISTORY_DEFAULT_LIMIT), CLI_HISTORY_MAX_LIMIT);
    const base = this.db.select().from(t);
    const filtered = conditions.length > 0 ? base.where(and(...conditions)) : base;
    const rows = await filtered.orderBy(desc(t.timestamp), desc(t.id)).limit(limit);
    return (rows as Record<string, unknown>[]).map(r => this.toRow(r));
  }

  /** Delete rows older than `days` days, in batches. Returns rows deleted. */
  async pruneOlderThan(days: number, batchSize: number = 5000): Promise<number> {
    const cutoff = this.now() - days * 24 * 60 * 60 * 1000;
    const { meshcoreCliHistory: t } = this.tables;
    let deleted = 0;
    for (;;) {
      const batch = await this.db
        .select({ id: t.id })
        .from(t)
        .where(lt(t.timestamp, cutoff))
        .orderBy(t.id)
        .limit(batchSize);
      if (batch.length === 0) break;
      const ids = (batch as Array<{ id: number }>).map(r => Number(r.id));
      await this.db.delete(t).where(inArray(t.id, ids));
      deleted += ids.length;
      if (batch.length < batchSize) break;
    }
    return deleted;
  }

  /** Drop everything a source recorded (the source was deleted). */
  async deleteBySourceId(sourceId: string): Promise<void> {
    if (!sourceId) throw new Error('MeshCoreCliHistoryRepository.deleteBySourceId requires a sourceId');
    const { meshcoreCliHistory: t } = this.tables;
    await this.db.delete(t).where(eq(t.sourceId, sourceId));
  }

  private toRow(r: Record<string, unknown>): MeshCoreCliHistoryRow {
    const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
    return {
      id: Number(r.id),
      sourceId: String(r.sourceId),
      timestamp: Number(r.timestamp),
      targetKind: r.targetKind as MeshCoreCliTargetKind,
      targetPublicKey: (r.targetPublicKey as string | null) ?? null,
      targetName: (r.targetName as string | null) ?? null,
      origin: r.origin as MeshCoreCliOrigin,
      userId: num(r.userId),
      username: (r.username as string | null) ?? null,
      command: String(r.command),
      outcome: r.outcome as MeshCoreCliOutcome,
      reply: (r.reply as string | null) ?? null,
      error: (r.error as string | null) ?? null,
      elapsedMs: num(r.elapsedMs),
      ipAddress: (r.ipAddress as string | null) ?? null,
    };
  }
}
