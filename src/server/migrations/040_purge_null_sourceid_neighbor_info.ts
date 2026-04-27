/**
 * Migration 040: Backfill neighbor_info rows with NULL sourceId.
 *
 * Two upgrade paths produce neighbor_info rows with `sourceId = NULL`:
 *  - v3.x → v4.0 upgrade: legacy single-source databases. Migration 021
 *    added the column nullable; v3 never wrote a value.
 *  - 4.0 beta write-path bug: `meshtasticManager.handleNeighborInfoApp`
 *    didn't forward `this.sourceId` into delete/insert. Fixed in beta4.
 *
 * Both states are equivalent — the rows belong to the user's "default"
 * source. Earlier versions of this migration deleted them, which silently
 * wiped neighbor history on upgrade. Reassign instead.
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
    // Legacy v3.x databases carry `neighbor_info.nodeNum REFERENCES nodes(nodeNum)`
    // and `neighbor_info.neighborNodeNum REFERENCES nodes(nodeNum)`. Migration 029
    // rebuilt nodes with composite PK (nodeNum, sourceId), so these FKs are
    // structurally invalid and writes on neighbor_info raise "foreign key
    // mismatch" with foreign_keys=ON. Disable FK enforcement and restore in
    // finally. See 029/030/032/039 for the same pattern.
    const prevForeignKeys = db.pragma('foreign_keys', { simple: true }) as number;
    if (prevForeignKeys) {
      db.pragma('foreign_keys = OFF');
    }
    try {
      const nullCountRow = db
        .prepare(`SELECT COUNT(*) AS c FROM neighbor_info WHERE sourceId IS NULL`)
        .get() as { c: number } | undefined;
      const nullCount = nullCountRow?.c ?? 0;
      if (nullCount === 0) {
        return;
      }

      const defaultSourceId = ensureDefaultSourceIdSqlite(db, 'Migration 040');
      if (!defaultSourceId) {
        logger.warn(
          `Migration 040: ${nullCount} NULL-sourceId neighbor_info rows but no sources table; skipping`
        );
        return;
      }

      const res = db
        .prepare(`UPDATE neighbor_info SET sourceId = ? WHERE sourceId IS NULL`)
        .run(defaultSourceId);
      if (res.changes > 0) {
        logger.info(
          `Migration 040: assigned ${res.changes} legacy neighbor_info rows to default source '${defaultSourceId}'`
        );
      }
    } finally {
      if (prevForeignKeys) {
        db.pragma('foreign_keys = ON');
      }
    }
  },
};

export async function runMigration040Postgres(client: any): Promise<void> {
  const nullRes = await client.query(
    `SELECT COUNT(*)::int AS c FROM neighbor_info WHERE "sourceId" IS NULL`
  );
  const nullCount = nullRes.rows[0]?.c ?? 0;
  if (nullCount === 0) {
    return;
  }

  const defaultSourceId = await ensureDefaultSourceIdPostgres(client, 'Migration 040');
  if (!defaultSourceId) {
    logger.warn(
      `Migration 040: ${nullCount} NULL-sourceId neighbor_info rows but no sources table; skipping (PG)`
    );
    return;
  }

  const res = await client.query(
    `UPDATE neighbor_info SET "sourceId" = $1 WHERE "sourceId" IS NULL`,
    [defaultSourceId],
  );
  if (res.rowCount && res.rowCount > 0) {
    logger.info(
      `Migration 040: assigned ${res.rowCount} legacy neighbor_info rows to default source '${defaultSourceId}' (PG)`
    );
  }
}

export async function runMigration040Mysql(pool: any): Promise<void> {
  const [nullRows] = await pool.query(
    `SELECT COUNT(*) AS c FROM neighbor_info WHERE sourceId IS NULL`
  );
  const nullCount = Number((nullRows as any[])[0]?.c ?? 0);
  if (nullCount === 0) {
    return;
  }

  const defaultSourceId = await ensureDefaultSourceIdMysql(pool, 'Migration 040');
  if (!defaultSourceId) {
    logger.warn(
      `Migration 040: ${nullCount} NULL-sourceId neighbor_info rows but no sources table; skipping (MySQL)`
    );
    return;
  }

  const [res] = await pool.query(
    `UPDATE neighbor_info SET sourceId = ? WHERE sourceId IS NULL`,
    [defaultSourceId],
  );
  const affected = (res as any).affectedRows ?? 0;
  if (affected > 0) {
    logger.info(
      `Migration 040: assigned ${affected} legacy neighbor_info rows to default source '${defaultSourceId}' (MySQL)`
    );
  }
}
