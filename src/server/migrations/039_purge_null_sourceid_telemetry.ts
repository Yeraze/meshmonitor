/**
 * Migration 039: Purge telemetry rows with NULL sourceId.
 *
 * Before v4.0.0-beta4 the write path in meshtasticManager.ts never passed
 * `this.sourceId` into `databaseService.insertTelemetry(...)`, so every
 * telemetry row inserted since migration 021 introduced the column was
 * persisted with `sourceId = NULL`. The read path filters strictly on
 * equality (`withSourceScope`), so source-scoped views returned zero rows
 * and the per-node TelemetryGraphs were empty.
 *
 * The write path is now fixed; this migration discards the stranded rows
 * so the read path can reflect incoming, correctly-tagged data.
 *
 * Idempotent — re-running is a no-op once NULL rows are gone.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up(db: Database): void {
    // Legacy v3.x databases carry `telemetry.nodeNum REFERENCES nodes(nodeNum)`.
    // Migration 029 rebuilt nodes with composite PK, so the FK is structurally
    // invalid and DELETE on telemetry raises "foreign key mismatch" with
    // foreign_keys=ON. Disable FK enforcement for this migration and restore
    // in finally. See 029/030/032 for the same pattern.
    const prevForeignKeys = db.pragma('foreign_keys', { simple: true }) as number;
    if (prevForeignKeys) {
      db.pragma('foreign_keys = OFF');
    }
    try {
      const res = db
        .prepare(`DELETE FROM telemetry WHERE sourceId IS NULL`)
        .run();
      if (res.changes > 0) {
        logger.info(`Migration 039: purged ${res.changes} telemetry rows with NULL sourceId`);
      }
    } finally {
      if (prevForeignKeys) {
        db.pragma('foreign_keys = ON');
      }
    }
  },
};

export async function runMigration039Postgres(client: any): Promise<void> {
  const res = await client.query(
    `DELETE FROM telemetry WHERE "sourceId" IS NULL`
  );
  if (res.rowCount && res.rowCount > 0) {
    logger.info(`Migration 039: purged ${res.rowCount} telemetry rows with NULL sourceId (PG)`);
  }
}

export async function runMigration039Mysql(pool: any): Promise<void> {
  const [res] = await pool.query(
    `DELETE FROM telemetry WHERE sourceId IS NULL`
  );
  const affected = (res as any).affectedRows ?? 0;
  if (affected > 0) {
    logger.info(`Migration 039: purged ${affected} telemetry rows with NULL sourceId (MySQL)`);
  }
}
