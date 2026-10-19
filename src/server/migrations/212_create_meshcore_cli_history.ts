/**
 * Migration 212: create `meshcore_cli_history` (issue #5892).
 *
 * One row per MeshCore CLI command a PERSON issued through MeshMonitor: the
 * Local and Remote consoles, the time-sync button, and a phone app using the
 * Virtual Node's CLI relay. Background CLI use (stats polls, config reads,
 * scheduled time sync, automations) is never recorded. PER-SOURCE — every row
 * carries a `sourceId`. Command and reply text are stored redacted.
 *
 * Idempotent on all three backends: pure `CREATE ... IF NOT EXISTS` (MySQL via
 * the information_schema helper). No backfill.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { createTableIfMissingMysql } from './helpers.js';

const LABEL = 'Migration 212';
const TABLE = 'meshcore_cli_history';
const SOURCE_TIME_INDEX = 'meshcore_cli_history_source_time_idx';
const TIME_INDEX = 'meshcore_cli_history_time_idx';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE}...`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sourceId TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        targetKind TEXT NOT NULL,
        targetPublicKey TEXT,
        targetName TEXT,
        origin TEXT NOT NULL,
        userId INTEGER,
        username TEXT,
        command TEXT NOT NULL,
        outcome TEXT NOT NULL,
        reply TEXT,
        error TEXT,
        elapsedMs INTEGER,
        ipAddress TEXT
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS ${SOURCE_TIME_INDEX} ON ${TABLE}(sourceId, timestamp)`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${TIME_INDEX} ON ${TABLE}(timestamp)`);

    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    logger.info(`${LABEL} down (SQLite): dropping ${TABLE}`);
    db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
  },
};

// ============ PostgreSQL ============

export async function runMigration212Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE}...`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id SERIAL PRIMARY KEY,
      "sourceId" TEXT NOT NULL,
      timestamp BIGINT NOT NULL,
      "targetKind" TEXT NOT NULL,
      "targetPublicKey" TEXT,
      "targetName" TEXT,
      origin TEXT NOT NULL,
      "userId" INTEGER,
      username TEXT,
      command TEXT NOT NULL,
      outcome TEXT NOT NULL,
      reply TEXT,
      error TEXT,
      "elapsedMs" INTEGER,
      "ipAddress" TEXT
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS ${SOURCE_TIME_INDEX} ON ${TABLE}("sourceId", timestamp)`);
  await client.query(`CREATE INDEX IF NOT EXISTS ${TIME_INDEX} ON ${TABLE}(timestamp)`);

  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration212Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${TABLE}...`);

  await createTableIfMissingMysql(pool, TABLE, `
    CREATE TABLE ${TABLE} (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sourceId VARCHAR(64) NOT NULL,
      timestamp BIGINT NOT NULL,
      targetKind VARCHAR(16) NOT NULL,
      targetPublicKey VARCHAR(64),
      targetName VARCHAR(255),
      origin VARCHAR(16) NOT NULL,
      userId INT,
      username VARCHAR(255),
      command TEXT NOT NULL,
      outcome VARCHAR(16) NOT NULL,
      reply TEXT,
      error TEXT,
      elapsedMs INT,
      ipAddress VARCHAR(64),
      INDEX ${SOURCE_TIME_INDEX} (sourceId, timestamp),
      INDEX ${TIME_INDEX} (timestamp)
    )
  `);

  logger.info(`${LABEL} complete (MySQL)`);
}
