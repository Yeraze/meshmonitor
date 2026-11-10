/**
 * Migration 230: confirmed new-neighbour tracking (#6274).
 *
 *   meshcore_neighbor_watch                a per-reporter ledger of the neighbours
 *                                          a repeater's table has listed: when each
 *                                          was first seen, last heard, and whether it
 *                                          is a baseline entry, a pending newcomer
 *                                          or confirmed. PER-SOURCE (sourceId).
 *   meshcore_nodes.neighborWatchBaselinedAt  bigint ms, nullable: set once a reporter
 *                                          has had its first evaluation (so deploy
 *                                          never alerts on the existing table).
 *
 * Only the neighbour watch writes either; `upsertNode` never writes the column.
 * Idempotent on all three backends. No backfill: it fills from live polls.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
  createTableIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 230';
const TABLE = 'meshcore_neighbor_watch';
const UNIQUE_INDEX = 'meshcore_neighbor_watch_uniq';
const SOURCE_INDEX = 'meshcore_neighbor_watch_source_idx';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE}...`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sourceId TEXT NOT NULL,
        reporterPublicKey TEXT NOT NULL,
        neighborPublicKey TEXT NOT NULL,
        state TEXT NOT NULL,
        firstSeenAt INTEGER NOT NULL,
        lastHeardAt INTEGER NOT NULL,
        lastSnr REAL,
        sightings INTEGER NOT NULL DEFAULT 0,
        updatedAt INTEGER NOT NULL
      )
    `);
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${UNIQUE_INDEX} ON ${TABLE}(sourceId, reporterPublicKey, neighborPublicKey)`
    );
    db.exec(`CREATE INDEX IF NOT EXISTS ${SOURCE_INDEX} ON ${TABLE}(sourceId)`);
    addColumnIfMissing(db, 'meshcore_nodes', 'neighborWatchBaselinedAt', 'neighborWatchBaselinedAt INTEGER');
    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    logger.info(`${LABEL} down (SQLite): dropping ${TABLE}`);
    db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
  },
};

// ============ PostgreSQL ============

export async function runMigration230Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE}...`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id SERIAL PRIMARY KEY,
      "sourceId" TEXT NOT NULL,
      "reporterPublicKey" TEXT NOT NULL,
      "neighborPublicKey" TEXT NOT NULL,
      state TEXT NOT NULL,
      "firstSeenAt" BIGINT NOT NULL,
      "lastHeardAt" BIGINT NOT NULL,
      "lastSnr" REAL,
      sightings INTEGER NOT NULL DEFAULT 0,
      "updatedAt" BIGINT NOT NULL
    )
  `);
  await client.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${UNIQUE_INDEX} ON ${TABLE}("sourceId", "reporterPublicKey", "neighborPublicKey")`
  );
  await client.query(`CREATE INDEX IF NOT EXISTS ${SOURCE_INDEX} ON ${TABLE}("sourceId")`);
  await addColumnIfMissingPostgres(
    client,
    'meshcore_nodes',
    'neighborWatchBaselinedAt',
    '"neighborWatchBaselinedAt" BIGINT'
  );
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration230Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${TABLE}...`);
  await createTableIfMissingMysql(
    pool,
    TABLE,
    `
    CREATE TABLE ${TABLE} (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sourceId VARCHAR(64) NOT NULL,
      reporterPublicKey VARCHAR(64) NOT NULL,
      neighborPublicKey VARCHAR(64) NOT NULL,
      state VARCHAR(16) NOT NULL,
      firstSeenAt BIGINT NOT NULL,
      lastHeardAt BIGINT NOT NULL,
      lastSnr DOUBLE,
      sightings INT NOT NULL DEFAULT 0,
      updatedAt BIGINT NOT NULL,
      UNIQUE KEY ${UNIQUE_INDEX} (sourceId, reporterPublicKey, neighborPublicKey),
      INDEX ${SOURCE_INDEX} (sourceId)
    )
  `
  );
  await addColumnIfMissingMysql(pool, 'meshcore_nodes', 'neighborWatchBaselinedAt', 'neighborWatchBaselinedAt BIGINT');
  logger.info(`${LABEL} complete (MySQL)`);
}
