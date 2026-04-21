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
    // Legacy v3.x databases carry `neighbor_info.nodeNum REFERENCES nodes(nodeNum)`
    // and `neighbor_info.neighborNodeNum REFERENCES nodes(nodeNum)`. Migration 029
    // rebuilt nodes with composite PK (nodeNum, sourceId), so these FKs are
    // structurally invalid and DELETE on neighbor_info raises
    // "foreign key mismatch" with foreign_keys=ON. Disable FK enforcement for
    // this migration and restore in finally. See 029/030/032/039 for the same
    // pattern.
    const prevForeignKeys = db.pragma('foreign_keys', { simple: true }) as number;
    if (prevForeignKeys) {
      db.pragma('foreign_keys = OFF');
    }
    try {
      const res = db
        .prepare(`DELETE FROM neighbor_info WHERE sourceId IS NULL`)
        .run();
      if (res.changes > 0) {
        logger.info(`Migration 040: purged ${res.changes} neighbor_info rows with NULL sourceId`);
      }
    } finally {
      if (prevForeignKeys) {
        db.pragma('foreign_keys = ON');
      }
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
