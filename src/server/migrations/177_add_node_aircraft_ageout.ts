/**
 * Migration 177: aircraft age-out and "confirmed fixed" columns on `nodes`
 * (#5364/#5365 Phase 2, AIRCRAFT_P2_SPEC.md "Data model").
 *
 *   aircraftAgedOutAt      INTEGER NULL — ms epoch the sweep ignored the node (D2)
 *   aircraftFixedAt        INTEGER NULL — ms epoch the fixed rule fired (D4)
 *   aircraftFixedLatitude  REAL    NULL — anchor latitude for the fixed mark
 *   aircraftFixedLongitude REAL    NULL — anchor longitude for the fixed mark
 *
 * No DEFAULT, no index. `upsertNode` never writes these columns; only the
 * aircraft repository methods do. Pure additive, idempotent `ADD COLUMN`
 * across SQLite / PostgreSQL / MySQL via the shared helpers (full DDL).
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 177';
const TABLE = 'nodes';

const COLS_SQLITE = [
  ['aircraftAgedOutAt', 'aircraftAgedOutAt INTEGER'],
  ['aircraftFixedAt', 'aircraftFixedAt INTEGER'],
  ['aircraftFixedLatitude', 'aircraftFixedLatitude REAL'],
  ['aircraftFixedLongitude', 'aircraftFixedLongitude REAL'],
] as const;

const COLS_PG = [
  ['aircraftAgedOutAt', '"aircraftAgedOutAt" BIGINT'],
  ['aircraftFixedAt', '"aircraftFixedAt" BIGINT'],
  ['aircraftFixedLatitude', '"aircraftFixedLatitude" DOUBLE PRECISION'],
  ['aircraftFixedLongitude', '"aircraftFixedLongitude" DOUBLE PRECISION'],
] as const;

const COLS_MYSQL = [
  ['aircraftAgedOutAt', 'aircraftAgedOutAt BIGINT'],
  ['aircraftFixedAt', 'aircraftFixedAt BIGINT'],
  ['aircraftFixedLatitude', 'aircraftFixedLatitude DOUBLE'],
  ['aircraftFixedLongitude', 'aircraftFixedLongitude DOUBLE'],
] as const;

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding aircraft age-out columns to ${TABLE}...`);
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

export async function runMigration177Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding aircraft age-out columns to ${TABLE}...`);
  for (const [column, ddl] of COLS_PG) {
    await addColumnIfMissingPostgres(client, TABLE, column, ddl);
  }
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration177Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding aircraft age-out columns to ${TABLE}...`);
  for (const [column, ddl] of COLS_MYSQL) {
    await addColumnIfMissingMysql(pool, TABLE, column, ddl);
  }
  logger.info(`${LABEL} complete (MySQL)`);
}
