/**
 * Migration 204: create `meshcore_admin_sessions` (issue #5785, "Resume Admin
 * Session").
 *
 * One row per (sourceId, targetPublicKey): "this source's companion logged in
 * to that remote node at `loggedInAt`, as `selfPublicKey`". The remote keeps a
 * logged-in client in its ACL with no idle timeout, so the console and the
 * scheduled jobs can send CLI commands without paying a fresh login exchange.
 * A row is only honoured while the connected companion's key still equals
 * `selfPublicKey`.
 *
 * PER-SOURCE — every row carries a `sourceId`. UNIQUE on
 * (sourceId, targetPublicKey).
 *
 * Idempotent on all three backends: pure `CREATE ... IF NOT EXISTS` (MySQL via
 * the information_schema helper). No backfill — the table starts empty and
 * fills from live logins.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { createTableIfMissingMysql } from './helpers.js';

const LABEL = 'Migration 204';
const TABLE = 'meshcore_admin_sessions';
const UNIQUE_INDEX = 'meshcore_admin_sessions_source_target_uniq';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE}...`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sourceId TEXT NOT NULL,
        targetPublicKey TEXT NOT NULL,
        selfPublicKey TEXT NOT NULL,
        loggedInAt INTEGER NOT NULL,
        isAdmin INTEGER
      )
    `);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${UNIQUE_INDEX} ON ${TABLE}(sourceId, targetPublicKey)`);

    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    logger.info(`${LABEL} down (SQLite): dropping ${TABLE}`);
    db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
  },
};

// ============ PostgreSQL ============

export async function runMigration204Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE}...`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id SERIAL PRIMARY KEY,
      "sourceId" TEXT NOT NULL,
      "targetPublicKey" TEXT NOT NULL,
      "selfPublicKey" TEXT NOT NULL,
      "loggedInAt" BIGINT NOT NULL,
      "isAdmin" BOOLEAN
    )
  `);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${UNIQUE_INDEX} ON ${TABLE}("sourceId", "targetPublicKey")`);

  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration204Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${TABLE}...`);

  await createTableIfMissingMysql(pool, TABLE, `
    CREATE TABLE ${TABLE} (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sourceId VARCHAR(64) NOT NULL,
      targetPublicKey VARCHAR(64) NOT NULL,
      selfPublicKey VARCHAR(64) NOT NULL,
      loggedInAt BIGINT NOT NULL,
      isAdmin BOOLEAN,
      UNIQUE KEY ${UNIQUE_INDEX} (sourceId, targetPublicKey)
    )
  `);

  logger.info(`${LABEL} complete (MySQL)`);
}
