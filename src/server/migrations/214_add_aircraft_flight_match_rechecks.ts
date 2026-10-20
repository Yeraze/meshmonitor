/**
 * Migration 214: re-check columns on `aircraft_flight_matches` (#5876).
 *
 *   lastLookupAt  BIGINT  NULL — ms; the last lookup or re-check that ran
 *   lastLookupLat REAL    NULL — the node's latitude at that lookup
 *   lastLookupLon REAL    NULL — the node's longitude at that lookup
 *   rechecks      INTEGER NOT NULL DEFAULT 0 — re-checks spent this flagging (cap 6)
 *   misses        INTEGER NOT NULL DEFAULT 0 — consecutive re-checks with no hit
 *
 * After the two initial lookups, a live fix may re-check the match when the
 * node has moved > 10 km or 15 min have passed since the last lookup. The
 * re-check count lives here, like `lookups`, so a restart or a settings save
 * cannot reset it. Pure additive, idempotent `ADD COLUMN` on all three
 * backends via the shared helpers (full DDL).
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 214';
const TABLE = 'aircraft_flight_matches';

const COLS_SQLITE = [
  ['lastLookupAt', 'lastLookupAt INTEGER'],
  ['lastLookupLat', 'lastLookupLat REAL'],
  ['lastLookupLon', 'lastLookupLon REAL'],
  ['rechecks', 'rechecks INTEGER NOT NULL DEFAULT 0'],
  ['misses', 'misses INTEGER NOT NULL DEFAULT 0'],
] as const;

const COLS_PG = [
  ['lastLookupAt', '"lastLookupAt" BIGINT'],
  ['lastLookupLat', '"lastLookupLat" DOUBLE PRECISION'],
  ['lastLookupLon', '"lastLookupLon" DOUBLE PRECISION'],
  ['rechecks', '"rechecks" INTEGER NOT NULL DEFAULT 0'],
  ['misses', '"misses" INTEGER NOT NULL DEFAULT 0'],
] as const;

const COLS_MYSQL = [
  ['lastLookupAt', 'lastLookupAt BIGINT'],
  ['lastLookupLat', 'lastLookupLat DOUBLE'],
  ['lastLookupLon', 'lastLookupLon DOUBLE'],
  ['rechecks', 'rechecks INT NOT NULL DEFAULT 0'],
  ['misses', 'misses INT NOT NULL DEFAULT 0'],
] as const;

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding re-check columns to ${TABLE}...`);
    for (const [column, ddl] of COLS_SQLITE) {
      addColumnIfMissing(db, TABLE, column, ddl);
    }
    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration214Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding re-check columns to ${TABLE}...`);
  for (const [column, ddl] of COLS_PG) {
    await addColumnIfMissingPostgres(client, TABLE, column, ddl);
  }
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration214Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding re-check columns to ${TABLE}...`);
  for (const [column, ddl] of COLS_MYSQL) {
    await addColumnIfMissingMysql(pool, TABLE, column, ddl);
  }
  logger.info(`${LABEL} complete (MySQL)`);
}
