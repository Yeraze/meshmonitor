/**
 * Migration 199: create `map_markers` (issue #5686, local map markers).
 *
 * Planning notes on the map that are never transmitted. PER-SOURCE — every row
 * carries a `sourceId`; indexed on it because every read is by source.
 *
 * Idempotent on all three backends: pure `CREATE ... IF NOT EXISTS` (MySQL via
 * the information_schema helper). No backfill — the table starts empty.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { createTableIfMissingMysql } from './helpers.js';

const LABEL = 'Migration 199';
const TABLE = 'map_markers';
const SOURCE_INDEX = 'map_markers_source_idx';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE}...`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sourceId TEXT NOT NULL,
        label TEXT NOT NULL,
        description TEXT,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        altitude REAL,
        icon TEXT NOT NULL,
        color TEXT NOT NULL,
        createdByUserId INTEGER,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS ${SOURCE_INDEX} ON ${TABLE}(sourceId)`);

    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    logger.info(`${LABEL} down (SQLite): dropping ${TABLE}`);
    db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
  },
};

// ============ PostgreSQL ============

export async function runMigration199Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE}...`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id SERIAL PRIMARY KEY,
      "sourceId" TEXT NOT NULL,
      label TEXT NOT NULL,
      description TEXT,
      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL,
      altitude DOUBLE PRECISION,
      icon TEXT NOT NULL,
      color TEXT NOT NULL,
      "createdByUserId" BIGINT,
      "createdAt" BIGINT NOT NULL,
      "updatedAt" BIGINT NOT NULL
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS ${SOURCE_INDEX} ON ${TABLE}("sourceId")`);

  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration199Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${TABLE}...`);

  await createTableIfMissingMysql(pool, TABLE, `
    CREATE TABLE ${TABLE} (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sourceId VARCHAR(64) NOT NULL,
      label VARCHAR(64) NOT NULL,
      description TEXT,
      latitude DOUBLE NOT NULL,
      longitude DOUBLE NOT NULL,
      altitude DOUBLE,
      icon VARCHAR(16) NOT NULL,
      color VARCHAR(16) NOT NULL,
      createdByUserId BIGINT,
      createdAt BIGINT NOT NULL,
      updatedAt BIGINT NOT NULL,
      INDEX ${SOURCE_INDEX} (sourceId)
    )
  `);

  logger.info(`${LABEL} complete (MySQL)`);
}
