/**
 * MeshCore Pathfinding Targets Repository (#4024)
 *
 * Backs the OR-union "specific contact" allowlist sub-filter for MeshCore
 * Auto-Pathfinding target filtering. One row per selected contact
 * `publicKey` per `sourceId`. Mirrors the allowlist half of
 * `AutoTracerouteRepository` (`getAutoTracerouteNodes`/`setAutoTracerouteNodes`),
 * keyed by `publicKey: string` instead of `nodeNum: number`.
 *
 * Every row is source-scoped — there is no legacy unscoped data for this
 * table, so `sourceId` is required (not optional) on both methods.
 */
import { eq, asc } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

export class MeshcorePathfindingTargetsRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  /** All selected target publicKeys for a source, ordered by createdAt asc. */
  async getTargets(sourceId: string): Promise<string[]> {
    const { meshcorePathfindingTargets } = this.tables;
    const rows = await this.db
      .select({ publicKey: meshcorePathfindingTargets.publicKey })
      .from(meshcorePathfindingTargets)
      .where(eq(meshcorePathfindingTargets.sourceId, sourceId))
      .orderBy(asc(meshcorePathfindingTargets.createdAt));
    return (rows as Array<{ publicKey: string }>).map((r) => String(r.publicKey));
  }

  /**
   * Replace the whole allowlist for a source (delete-then-insert).
   * Input keys are de-duped so the UNIQUE(sourceId, publicKey) constraint is
   * never violated.
   *
   * The delete and the (single, batched) insert run inside one Drizzle
   * transaction so both statements land on the same pinned connection/client
   * — mirrors the cross-backend pattern in `messages.ts`'s channel-move
   * migration: SQLite's `better-sqlite3` transaction callback must be
   * synchronous, while PostgreSQL/MySQL require an async callback, so we
   * branch on dialect rather than inventing a new transaction mechanism.
   */
  async setTargets(publicKeys: string[], sourceId: string): Promise<void> {
    const now = this.now();
    const { meshcorePathfindingTargets } = this.tables;
    const deduped = [...new Set(publicKeys)];
    const rows = deduped.map((publicKey) => ({ sourceId, publicKey, createdAt: now }));

    if (this.isSQLite()) {
      this.getSqliteDb().transaction((tx) => {
        tx.delete(meshcorePathfindingTargets).where(eq(meshcorePathfindingTargets.sourceId, sourceId)).run();
        if (rows.length > 0) {
          tx.insert(meshcorePathfindingTargets).values(rows).run();
        }
      });
    } else if (this.isPostgres()) {
      await this.getPostgresDb().transaction(async (tx) => {
        await tx.delete(meshcorePathfindingTargets).where(eq(meshcorePathfindingTargets.sourceId, sourceId));
        if (rows.length > 0) {
          await tx.insert(meshcorePathfindingTargets).values(rows);
        }
      });
    } else {
      await this.getMysqlDb().transaction(async (tx) => {
        await tx.delete(meshcorePathfindingTargets).where(eq(meshcorePathfindingTargets.sourceId, sourceId));
        if (rows.length > 0) {
          await tx.insert(meshcorePathfindingTargets).values(rows);
        }
      });
    }
  }
}
