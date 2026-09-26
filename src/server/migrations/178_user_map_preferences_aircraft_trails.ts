/**
 * Migration 178: likely-aircraft flight trails on `user_map_preferences`
 * (#5364/#5365 Phase 3, decisions D2/D4).
 *
 *   show_aircraft_trails  BOOLEAN  DEFAULT false — draw a trail per visible aircraft
 *   aircraft_trail_hours  INTEGER  DEFAULT 6     — lookback window, 1..168 h
 *
 * Per-user, server-persisted like the other Map Features toggles in this
 * table (the `aircraft_display_mode` migration 176 precedent). The route
 * validates the 1..168 range; the column stores whatever passed validation.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 178';
const TABLE = 'user_map_preferences';

const COLS_SQLITE = [
  ['show_aircraft_trails', 'show_aircraft_trails INTEGER DEFAULT 0'],
  ['aircraft_trail_hours', 'aircraft_trail_hours INTEGER DEFAULT 6'],
] as const;

const COLS_PG = [
  ['show_aircraft_trails', '"show_aircraft_trails" BOOLEAN DEFAULT FALSE'],
  ['aircraft_trail_hours', '"aircraft_trail_hours" INTEGER DEFAULT 6'],
] as const;

const COLS_MYSQL = [
  ['show_aircraft_trails', 'show_aircraft_trails BOOLEAN DEFAULT FALSE'],
  ['aircraft_trail_hours', 'aircraft_trail_hours INT DEFAULT 6'],
] as const;

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding aircraft trail columns to ${TABLE}...`);
    for (const [column, ddl] of COLS_SQLITE) {
      addColumnIfMissing(db, TABLE, column, ddl);
    }
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration178Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding aircraft trail columns to ${TABLE}...`);
  for (const [column, ddl] of COLS_PG) {
    await addColumnIfMissingPostgres(client, TABLE, column, ddl);
  }
}

// ============ MySQL ============

export async function runMigration178Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding aircraft trail columns to ${TABLE}...`);
  for (const [column, ddl] of COLS_MYSQL) {
    await addColumnIfMissingMysql(pool, TABLE, column, ddl);
  }
}
