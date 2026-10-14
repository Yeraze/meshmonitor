/**
 * Repository for `meshcore_admin_sessions` (issue #5785, "Resume Admin
 * Session").
 *
 * Per (source, remote node): the source's companion logged in to that node,
 * as which key, and when. PER-SOURCE — every read and write takes a
 * `sourceId`. The policy (when a row is honoured, recorded or cleared) lives in
 * `MeshCoreManager`; this file only stores rows.
 */
import { and, eq } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

export interface MeshCoreAdminSessionRow {
  sourceId: string;
  targetPublicKey: string;
  selfPublicKey: string;
  loggedInAt: number;
  isAdmin: boolean | null;
}

export class MeshCoreAdminSessionsRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  private requireSource(sourceId: string, op: string): void {
    if (!sourceId) throw new Error(`MeshCoreAdminSessionsRepository.${op} requires a sourceId`);
  }

  private toRow(raw: Record<string, unknown>): MeshCoreAdminSessionRow {
    const r = this.normalizeBigInts(raw) as Record<string, unknown>;
    return {
      sourceId: String(r.sourceId),
      targetPublicKey: String(r.targetPublicKey),
      selfPublicKey: String(r.selfPublicKey),
      loggedInAt: Number(r.loggedInAt),
      // SQLite boolean mode gives true/false; MySQL can hand back 0/1.
      isAdmin: r.isAdmin === null || r.isAdmin === undefined ? null : Boolean(r.isAdmin),
    };
  }

  async get(sourceId: string, targetPublicKey: string): Promise<MeshCoreAdminSessionRow | null> {
    this.requireSource(sourceId, 'get');
    const t = this.tables.meshcoreAdminSessions;
    const rows = await this.db
      .select()
      .from(t)
      .where(and(this.withSourceScope(t, sourceId), eq(t.targetPublicKey, targetPublicKey.toLowerCase())))
      .limit(1);
    return rows[0] ? this.toRow(rows[0]) : null;
  }

  /** Insert or replace the row for (sourceId, targetPublicKey). */
  async record(row: MeshCoreAdminSessionRow): Promise<void> {
    this.requireSource(row.sourceId, 'record');
    const t = this.tables.meshcoreAdminSessions;
    const set = {
      selfPublicKey: row.selfPublicKey.toLowerCase(),
      loggedInAt: row.loggedInAt,
      isAdmin: row.isAdmin,
    };
    await this.upsert(
      t,
      { sourceId: row.sourceId, targetPublicKey: row.targetPublicKey.toLowerCase(), ...set },
      [t.sourceId, t.targetPublicKey],
      set,
    );
  }

  async clear(sourceId: string, targetPublicKey: string): Promise<void> {
    this.requireSource(sourceId, 'clear');
    const t = this.tables.meshcoreAdminSessions;
    await this.db
      .delete(t)
      .where(and(this.withSourceScope(t, sourceId), eq(t.targetPublicKey, targetPublicKey.toLowerCase())));
  }

  async deleteBySourceId(sourceId: string): Promise<void> {
    this.requireSource(sourceId, 'deleteBySourceId');
    const t = this.tables.meshcoreAdminSessions;
    await this.db.delete(t).where(this.withSourceScope(t, sourceId));
  }
}
