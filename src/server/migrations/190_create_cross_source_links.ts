/**
 * Migration 190: create `cross_source_links` (#5561, map "heard here" edges).
 *
 * Hourly aggregate of "source A's radio was heard by source B". Starts empty
 * and fills going forward from the live RX paths; no backfill. A row names
 * two sources (`txSourceId`, `rxSourceId`) and has no single `sourceId`.
 *
 * Every unique-key column is NOT NULL: all three backends treat NULL as
 * distinct in a UNIQUE index, which would defeat the per-hour upsert.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL. See
 * `src/db/schema/crossSourceLinks.ts` for the column notes.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { createTableIfMissingMysql } from './helpers.js';

const LABEL = 'Migration 190';
const TABLE = 'cross_source_links';
const UNIQUE_INDEX = 'xs_links_bucket_uniq';
const BUCKET_INDEX = 'xs_links_bucket_idx';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE}...`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        txSourceId TEXT NOT NULL,
        txNodeId TEXT NOT NULL,
        rxSourceId TEXT NOT NULL,
        rxNodeId TEXT NOT NULL,
        protocol TEXT NOT NULL,
        kind TEXT NOT NULL,
        transportClass TEXT NOT NULL,
        hourBucket INTEGER NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        snrMin REAL,
        snrAvg REAL,
        snrMax REAL,
        snrCount INTEGER NOT NULL DEFAULT 0,
        rssiAvg REAL,
        rssiCount INTEGER NOT NULL DEFAULT 0,
        lastHeardAt INTEGER NOT NULL
      )
    `);

    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${UNIQUE_INDEX} ON ${TABLE}(txSourceId, txNodeId, rxSourceId, rxNodeId, kind, transportClass, hourBucket)`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${BUCKET_INDEX} ON ${TABLE}(hourBucket)`);

    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    logger.info(`${LABEL} down (SQLite): dropping ${TABLE}`);
    db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
  },
};

// ============ PostgreSQL ============

export async function runMigration190Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE}...`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id SERIAL PRIMARY KEY,
      "txSourceId" TEXT NOT NULL,
      "txNodeId" TEXT NOT NULL,
      "rxSourceId" TEXT NOT NULL,
      "rxNodeId" TEXT NOT NULL,
      protocol TEXT NOT NULL,
      kind TEXT NOT NULL,
      "transportClass" TEXT NOT NULL,
      "hourBucket" BIGINT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      "snrMin" DOUBLE PRECISION,
      "snrAvg" DOUBLE PRECISION,
      "snrMax" DOUBLE PRECISION,
      "snrCount" INTEGER NOT NULL DEFAULT 0,
      "rssiAvg" DOUBLE PRECISION,
      "rssiCount" INTEGER NOT NULL DEFAULT 0,
      "lastHeardAt" BIGINT NOT NULL
    )
  `);

  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${UNIQUE_INDEX} ON ${TABLE}("txSourceId", "txNodeId", "rxSourceId", "rxNodeId", kind, "transportClass", "hourBucket")`);
  await client.query(`CREATE INDEX IF NOT EXISTS ${BUCKET_INDEX} ON ${TABLE}("hourBucket")`);

  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration190Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${TABLE}...`);

  // COUNT is a function name in MySQL, so the column is backtick-quoted.
  await createTableIfMissingMysql(pool, TABLE, `
    CREATE TABLE ${TABLE} (
      id INT AUTO_INCREMENT PRIMARY KEY,
      txSourceId VARCHAR(64) NOT NULL,
      txNodeId VARCHAR(80) NOT NULL,
      rxSourceId VARCHAR(64) NOT NULL,
      rxNodeId VARCHAR(80) NOT NULL,
      protocol VARCHAR(16) NOT NULL,
      kind VARCHAR(16) NOT NULL,
      transportClass VARCHAR(16) NOT NULL,
      hourBucket BIGINT NOT NULL,
      \`count\` INT NOT NULL DEFAULT 0,
      snrMin DOUBLE,
      snrAvg DOUBLE,
      snrMax DOUBLE,
      snrCount INT NOT NULL DEFAULT 0,
      rssiAvg DOUBLE,
      rssiCount INT NOT NULL DEFAULT 0,
      lastHeardAt BIGINT NOT NULL,
      UNIQUE KEY ${UNIQUE_INDEX} (txSourceId, txNodeId, rxSourceId, rxNodeId, kind, transportClass, hourBucket),
      INDEX ${BUCKET_INDEX} (hourBucket)
    )
  `);

  logger.info(`${LABEL} complete (MySQL)`);
}
