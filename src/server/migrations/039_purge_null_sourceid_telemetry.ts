/**
 * Migration 039: Backfill telemetry rows with NULL sourceId.
 *
 * Two upgrade paths produce telemetry rows with `sourceId = NULL`:
 *  - v3.x → v4.0 upgrade: legacy single-source databases. Migration 021
 *    added the column nullable; v3 never wrote a value.
 *  - 4.0.0-beta1..beta3 write-path bug: meshtasticManager.ts didn't forward
 *    `this.sourceId` into `insertTelemetry`. Fixed in beta4.
 *
 * Both states are equivalent — the rows belong to the user's "default"
 * source (the only source that existed when they were captured). Earlier
 * versions of this migration deleted them, which silently wiped the entire
 * telemetry history on upgrade. Reassign instead.
 *
 * Idempotent — once every row has a sourceId, re-runs update 0 rows.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  ensureDefaultSourceIdSqlite,
  ensureDefaultSourceIdPostgres,
  ensureDefaultSourceIdMysql,
} from './_legacyDefaultSource.js';

export const migration = {
  up(db: Database): void {
    // Legacy v3.x databases carry `telemetry.nodeNum REFERENCES nodes(nodeNum)`.
    // Migration 029 rebuilt nodes with composite PK, so the FK is structurally
    // invalid and any write on telemetry raises "foreign key mismatch" with
    // foreign_keys=ON. Disable FK enforcement and restore in finally. See
    // 029/030/032/040 for the same pattern.
    const prevForeignKeys = db.pragma('foreign_keys', { simple: true }) as number;
    if (prevForeignKeys) {
      db.pragma('foreign_keys = OFF');
    }
    try {
      const nullCountRow = db
        .prepare(`SELECT COUNT(*) AS c FROM telemetry WHERE sourceId IS NULL`)
        .get() as { c: number } | undefined;
      const nullCount = nullCountRow?.c ?? 0;
      if (nullCount === 0) {
        return;
      }

      const defaultSourceId = ensureDefaultSourceIdSqlite(db, 'Migration 039');
      if (!defaultSourceId) {
        // Sources table doesn't exist yet (db never ran migration 020). Leave
        // rows alone — server.ts startup will assign once a source is registered.
        logger.warn(
          `Migration 039: ${nullCount} NULL-sourceId telemetry rows but no sources table; skipping`
        );
        return;
      }

      const res = db
        .prepare(`UPDATE telemetry SET sourceId = ? WHERE sourceId IS NULL`)
        .run(defaultSourceId);
      if (res.changes > 0) {
        logger.info(
          `Migration 039: assigned ${res.changes} legacy telemetry rows to default source '${defaultSourceId}'`
        );
      }
    } finally {
      if (prevForeignKeys) {
        db.pragma('foreign_keys = ON');
      }
    }
  },
};

export async function runMigration039Postgres(client: any): Promise<void> {
  const nullRes = await client.query(
    `SELECT COUNT(*)::int AS c FROM telemetry WHERE "sourceId" IS NULL`
  );
  const nullCount = nullRes.rows[0]?.c ?? 0;
  if (nullCount === 0) {
    return;
  }

  const defaultSourceId = await ensureDefaultSourceIdPostgres(client, 'Migration 039');
  if (!defaultSourceId) {
    logger.warn(
      `Migration 039: ${nullCount} NULL-sourceId telemetry rows but no sources table; skipping (PG)`
    );
    return;
  }

  const res = await client.query(
    `UPDATE telemetry SET "sourceId" = $1 WHERE "sourceId" IS NULL`,
    [defaultSourceId],
  );
  if (res.rowCount && res.rowCount > 0) {
    logger.info(
      `Migration 039: assigned ${res.rowCount} legacy telemetry rows to default source '${defaultSourceId}' (PG)`
    );
  }
}

export async function runMigration039Mysql(pool: any): Promise<void> {
  const [nullRows] = await pool.query(
    `SELECT COUNT(*) AS c FROM telemetry WHERE sourceId IS NULL`
  );
  const nullCount = Number((nullRows as any[])[0]?.c ?? 0);
  if (nullCount === 0) {
    return;
  }

  const defaultSourceId = await ensureDefaultSourceIdMysql(pool, 'Migration 039');
  if (!defaultSourceId) {
    logger.warn(
      `Migration 039: ${nullCount} NULL-sourceId telemetry rows but no sources table; skipping (MySQL)`
    );
    return;
  }

  const [res] = await pool.query(
    `UPDATE telemetry SET sourceId = ? WHERE sourceId IS NULL`,
    [defaultSourceId],
  );
  const affected = (res as any).affectedRows ?? 0;
  if (affected > 0) {
    logger.info(
      `Migration 039: assigned ${affected} legacy telemetry rows to default source '${defaultSourceId}' (MySQL)`
    );
  }
}
