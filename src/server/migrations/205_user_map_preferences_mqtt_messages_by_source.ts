/**
 * Migration 205: per-source "Show MQTT/Bridge Messages" on
 * `user_map_preferences` (#5824).
 *
 *   show_mqtt_messages_by_source  TEXT  NULL — JSON object { [sourceId]: boolean }
 *
 * The toggle used to live in one browser-global localStorage key, so it
 * flipped for every source and reset on a fresh browser. It is now stored per
 * user and per source. NULL (or a missing key) means "never set" and the
 * client falls back to its local value.
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

const LABEL = 'Migration 205';
const TABLE = 'user_map_preferences';
const COLUMN = 'show_mqtt_messages_by_source';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding ${COLUMN} to ${TABLE}...`);
    addColumnIfMissing(db, TABLE, COLUMN, `${COLUMN} TEXT`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration205Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${COLUMN} to ${TABLE}...`);
  await addColumnIfMissingPostgres(client, TABLE, COLUMN, `"${COLUMN}" TEXT`);
}

// ============ MySQL ============

export async function runMigration205Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${COLUMN} to ${TABLE}...`);
  await addColumnIfMissingMysql(pool, TABLE, COLUMN, `${COLUMN} TEXT`);
}
