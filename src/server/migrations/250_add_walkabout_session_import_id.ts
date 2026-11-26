/**
 * Migration 250: tag imported walkabout sessions (#6573).
 *
 * Adds a nullable `importId` to `coverage_walkabout_sessions`. Null = recorded
 * live on this instance; set = created by a walkabout import (a
 * `coverage_imports` row with `kind = 'walkabout'`). Samples and receptions
 * belong to their session, so the session column is enough. Idempotent on all
 * three backends.
 */
import type { Database } from 'better-sqlite3';
import { addColumnIfMissing, addColumnIfMissingPostgres, addColumnIfMissingMysql, createIndexIfMissingMysql } from './helpers.js';

const SESS = 'coverage_walkabout_sessions';

export const migration = {
  up: (db: Database): void => {
    addColumnIfMissing(db, SESS, 'importId', 'importId TEXT');
    db.exec(`CREATE INDEX IF NOT EXISTS cov_wk_sess_import_idx ON ${SESS}(importId) WHERE importId IS NOT NULL`);
  },
};

export async function runMigration250Postgres(client: import('pg').PoolClient): Promise<void> {
  await addColumnIfMissingPostgres(client, SESS, 'importId', '"importId" TEXT');
  await client.query(`CREATE INDEX IF NOT EXISTS cov_wk_sess_import_idx ON ${SESS}("importId") WHERE "importId" IS NOT NULL`);
}

export async function runMigration250Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  await addColumnIfMissingMysql(pool, SESS, 'importId', '`importId` VARCHAR(36) NULL');
  await createIndexIfMissingMysql(pool, SESS, 'cov_wk_sess_import_idx', `CREATE INDEX cov_wk_sess_import_idx ON ${SESS}(importId)`);
}
