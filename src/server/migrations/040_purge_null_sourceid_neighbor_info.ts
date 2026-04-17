/**
 * Migration 040: Purge neighbor_info rows with NULL sourceId.
 *
 * Before the fix in this release, `meshtasticManager.handleNeighborInfoApp`
 * called `deleteNeighborInfoForNode(fromNum)` and `insertNeighborInfoBatch(
 * records)` without forwarding `this.sourceId`. The repository treats an
 * undefined sourceId as "no filter", so:
 *   - the delete wiped every source's neighbor rows for that node, and
 *   - the re-insert wrote NULL sourceId, making the rows invisible to the
 *     source-scoped read path (`withSourceScope` strict equality).
 *
 * Write path is now fixed (both calls forward `this.sourceId`); this
 * migration discards the stranded rows so future data reflects correct
 * per-source attribution.
 *
 * Idempotent — re-running is a no-op once NULL rows are gone.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up(db: Database): void {
    const res = db
      .prepare(`DELETE FROM neighbor_info WHERE sourceId IS NULL`)
      .run();
    if (res.changes > 0) {
      logger.info(`Migration 040: purged ${res.changes} neighbor_info rows with NULL sourceId`);
    }
  },
};

export async function runMigration040Postgres(client: any): Promise<void> {
  const res = await client.query(
    `DELETE FROM neighbor_info WHERE "sourceId" IS NULL`
  );
  if (res.rowCount && res.rowCount > 0) {
    logger.info(`Migration 040: purged ${res.rowCount} neighbor_info rows with NULL sourceId (PG)`);
  }
}

export async function runMigration040Mysql(pool: any): Promise<void> {
  const [res] = await pool.query(
    `DELETE FROM neighbor_info WHERE sourceId IS NULL`
  );
  const affected = (res as any).affectedRows ?? 0;
  if (affected > 0) {
    logger.info(`Migration 040: purged ${affected} neighbor_info rows with NULL sourceId (MySQL)`);
  }
}
