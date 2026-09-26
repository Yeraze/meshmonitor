/**
 * Migration 176: `user_map_preferences.aircraft_display_mode` (#5364/#5365
 * Phase 1 WP1, decision D12).
 *
 * How the map shows nodes classified as likely aircraft:
 *
 *   aircraft_display_mode  TEXT  NULL  — 'show' | 'mark' | 'hide'
 *
 * NULL reads as 'mark' (badge the marker, no filtering) — matches today's
 * behaviour for everyone who has not chosen anything else. Per-user, server-
 * persisted like the other Map Features toggles in this table (the
 * `spread_nodes` #5177 precedent), mirrored to `localStorage` for anonymous
 * viewers who get a 403 on save.
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

const LABEL = 'Migration 176';
const TABLE = 'user_map_preferences';
const COLUMN = 'aircraft_display_mode';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding ${TABLE}.${COLUMN}...`);
    addColumnIfMissing(db, TABLE, COLUMN, `${COLUMN} TEXT`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration176Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${TABLE}.${COLUMN}...`);
  await addColumnIfMissingPostgres(client, TABLE, COLUMN, `"${COLUMN}" TEXT`);
}

// ============ MySQL ============

export async function runMigration176Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${TABLE}.${COLUMN}...`);
  await addColumnIfMissingMysql(pool, TABLE, COLUMN, `${COLUMN} VARCHAR(8)`);
}
