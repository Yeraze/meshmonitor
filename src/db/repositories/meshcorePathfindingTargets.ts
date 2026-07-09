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
   */
  async setTargets(publicKeys: string[], sourceId: string): Promise<void> {
    const now = this.now();
    const { meshcorePathfindingTargets } = this.tables;

    await this.db
      .delete(meshcorePathfindingTargets)
      .where(eq(meshcorePathfindingTargets.sourceId, sourceId));

    const deduped = [...new Set(publicKeys)];
    for (const publicKey of deduped) {
      await this.db
        .insert(meshcorePathfindingTargets)
        .values({ sourceId, publicKey, createdAt: now });
    }
  }
}
