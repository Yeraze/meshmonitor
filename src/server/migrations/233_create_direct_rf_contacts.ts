/**
 * Migration 233: create `direct_rf_contacts` (#6210, Direct RF Contacts).
 *
 * A daily rollup of the nodes each source's own radio heard directly over RF
 * (zero hops, not via MQTT). One row per (source, node, UTC day). Starts
 * empty and fills going forward from the live RX paths; no backfill.
 *
 * Per-source: every row carries a `sourceId`. Every unique-key column is
 * NOT NULL, since all three backends treat NULL as distinct in a UNIQUE
 * index, which would defeat the per-day upsert.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL. See
 * `src/db/schema/directRfContacts.ts` for the column notes.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { createTableIfMissingMysql } from './helpers.js';

const LABEL = 'Migration 233';
const TABLE = 'direct_rf_contacts';
const UNIQUE_INDEX = 'direct_rf_contacts_day_uniq';
const SOURCE_DAY_INDEX = 'direct_rf_contacts_source_day_idx';
const DAY_INDEX = 'direct_rf_contacts_day_idx';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE}...`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sourceId TEXT NOT NULL,
        protocol TEXT NOT NULL,
        nodeKey TEXT NOT NULL,
        nodeNum INTEGER,
        dayBucket INTEGER NOT NULL,
        firstHeardAt INTEGER NOT NULL,
        lastHeardAt INTEGER NOT NULL,
        receptionCount INTEGER NOT NULL DEFAULT 0,
        bestSnr REAL,
        bestRssi REAL,
        snrSum REAL NOT NULL DEFAULT 0,
        snrCount INTEGER NOT NULL DEFAULT 0,
        rssiSum REAL NOT NULL DEFAULT 0,
        rssiCount INTEGER NOT NULL DEFAULT 0
      )
    `);

    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${UNIQUE_INDEX} ON ${TABLE}(sourceId, nodeKey, dayBucket)`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${SOURCE_DAY_INDEX} ON ${TABLE}(sourceId, dayBucket)`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${DAY_INDEX} ON ${TABLE}(dayBucket)`);

    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    logger.info(`${LABEL} down (SQLite): dropping ${TABLE}`);
    db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
  },
};

// ============ PostgreSQL ============

export async function runMigration233Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE}...`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id SERIAL PRIMARY KEY,
      "sourceId" TEXT NOT NULL,
      protocol TEXT NOT NULL,
      "nodeKey" TEXT NOT NULL,
      "nodeNum" BIGINT,
      "dayBucket" BIGINT NOT NULL,
      "firstHeardAt" BIGINT NOT NULL,
      "lastHeardAt" BIGINT NOT NULL,
      "receptionCount" INTEGER NOT NULL DEFAULT 0,
      "bestSnr" DOUBLE PRECISION,
      "bestRssi" DOUBLE PRECISION,
      "snrSum" DOUBLE PRECISION NOT NULL DEFAULT 0,
      "snrCount" INTEGER NOT NULL DEFAULT 0,
      "rssiSum" DOUBLE PRECISION NOT NULL DEFAULT 0,
      "rssiCount" INTEGER NOT NULL DEFAULT 0
    )
  `);

  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${UNIQUE_INDEX} ON ${TABLE}("sourceId", "nodeKey", "dayBucket")`);
  await client.query(`CREATE INDEX IF NOT EXISTS ${SOURCE_DAY_INDEX} ON ${TABLE}("sourceId", "dayBucket")`);
  await client.query(`CREATE INDEX IF NOT EXISTS ${DAY_INDEX} ON ${TABLE}("dayBucket")`);

  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration233Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${TABLE}...`);

  await createTableIfMissingMysql(pool, TABLE, `
    CREATE TABLE ${TABLE} (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sourceId VARCHAR(64) NOT NULL,
      protocol VARCHAR(16) NOT NULL,
      nodeKey VARCHAR(80) NOT NULL,
      nodeNum BIGINT,
      dayBucket BIGINT NOT NULL,
      firstHeardAt BIGINT NOT NULL,
      lastHeardAt BIGINT NOT NULL,
      receptionCount INT NOT NULL DEFAULT 0,
      bestSnr DOUBLE,
      bestRssi DOUBLE,
      snrSum DOUBLE NOT NULL DEFAULT 0,
      snrCount INT NOT NULL DEFAULT 0,
      rssiSum DOUBLE NOT NULL DEFAULT 0,
      rssiCount INT NOT NULL DEFAULT 0,
      UNIQUE KEY ${UNIQUE_INDEX} (sourceId, nodeKey, dayBucket),
      INDEX ${SOURCE_DAY_INDEX} (sourceId, dayBucket),
      INDEX ${DAY_INDEX} (dayBucket)
    )
  `);

  logger.info(`${LABEL} complete (MySQL)`);
}
