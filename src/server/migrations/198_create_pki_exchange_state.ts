/**
 * Migration 198: create `pki_exchange_state` (issue #5691, "Reliable PKI").
 *
 * One row per (sourceId, nodeNum): the outcome of the last PKI-encrypted
 * exchange MeshMonitor started with that node (`successful` / `pending` /
 * `failed`, with timestamps), plus `lastPrimedAt`, the hourly safety timer for
 * priming NodeInfo sends. The timer lives in the database so that neither a
 * restart nor a settings save can reset it (CLAUDE.md Mesh impact checklist).
 *
 * PER-SOURCE — every row carries a `sourceId`. UNIQUE on (sourceId, nodeNum).
 *
 * Idempotent on all three backends: pure `CREATE ... IF NOT EXISTS` (MySQL via
 * the information_schema helper). No backfill — the table starts empty and
 * fills from live sends.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { createTableIfMissingMysql } from './helpers.js';

const LABEL = 'Migration 198';
const TABLE = 'pki_exchange_state';
const UNIQUE_INDEX = 'pki_exchange_state_source_node_uniq';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE}...`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sourceId TEXT NOT NULL,
        nodeNum INTEGER NOT NULL,
        state TEXT NOT NULL,
        stateChangedAt INTEGER NOT NULL,
        lastSuccessAt INTEGER,
        failingSince INTEGER,
        lastFailureReason TEXT,
        lastPrimedAt INTEGER,
        updatedAt INTEGER NOT NULL
      )
    `);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${UNIQUE_INDEX} ON ${TABLE}(sourceId, nodeNum)`);

    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    logger.info(`${LABEL} down (SQLite): dropping ${TABLE}`);
    db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
  },
};

// ============ PostgreSQL ============

export async function runMigration198Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE}...`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id SERIAL PRIMARY KEY,
      "sourceId" TEXT NOT NULL,
      "nodeNum" BIGINT NOT NULL,
      state TEXT NOT NULL,
      "stateChangedAt" BIGINT NOT NULL,
      "lastSuccessAt" BIGINT,
      "failingSince" BIGINT,
      "lastFailureReason" TEXT,
      "lastPrimedAt" BIGINT,
      "updatedAt" BIGINT NOT NULL
    )
  `);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${UNIQUE_INDEX} ON ${TABLE}("sourceId", "nodeNum")`);

  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration198Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${TABLE}...`);

  await createTableIfMissingMysql(pool, TABLE, `
    CREATE TABLE ${TABLE} (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sourceId VARCHAR(64) NOT NULL,
      nodeNum BIGINT NOT NULL,
      state VARCHAR(16) NOT NULL,
      stateChangedAt BIGINT NOT NULL,
      lastSuccessAt BIGINT,
      failingSince BIGINT,
      lastFailureReason VARCHAR(32),
      lastPrimedAt BIGINT,
      updatedAt BIGINT NOT NULL,
      UNIQUE KEY ${UNIQUE_INDEX} (sourceId, nodeNum)
    )
  `);

  logger.info(`${LABEL} complete (MySQL)`);
}
