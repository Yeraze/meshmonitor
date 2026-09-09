/**
 * Migration 161: `user_map_preferences.unread_indicator_enabled` (#5124).
 *
 * The Sources list gains a per-source unread-DM badge. A reporter running 5+
 * sources — several of which see the same traffic — expects it lit more or
 * less permanently, so the badge ships with a way to turn it off.
 *
 * Per-user rather than global: unread state is already per-user
 * (`read_messages.user_id`), so "do I want to see this" belongs beside the
 * other per-user display toggles (`show_mqtt_nodes` and friends) in this very
 * table, not in global settings.
 *
 *   unread_indicator_enabled  BOOLEAN  DEFAULT TRUE
 *
 * Defaulting TRUE, unlike the opt-in toggles nearby: the badge is the feature
 * this migration exists to enable, so an existing user should see it without
 * hunting for a switch. NULL on rows written before this migration reads as
 * "not set" and the frontend treats that as enabled, matching the default.
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

const LABEL = 'Migration 161';
const TABLE = 'user_map_preferences';
const COLUMN = 'unread_indicator_enabled';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding ${TABLE}.${COLUMN}...`);
    addColumnIfMissing(db, TABLE, COLUMN, `${COLUMN} INTEGER DEFAULT 1`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration161Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${TABLE}.${COLUMN}...`);
  await addColumnIfMissingPostgres(client, TABLE, COLUMN, `"${COLUMN}" BOOLEAN DEFAULT TRUE`);
}

// ============ MySQL ============

export async function runMigration161Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${TABLE}.${COLUMN}...`);
  await addColumnIfMissingMysql(pool, TABLE, COLUMN, `${COLUMN} BOOLEAN DEFAULT TRUE`);
}
