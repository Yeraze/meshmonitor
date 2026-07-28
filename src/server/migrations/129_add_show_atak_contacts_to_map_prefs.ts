/**
 * Migration 129: Add `show_atak_contacts` column to `user_map_preferences`.
 *
 * The ATAK/CoT Phase 2 work (#3691) added a "Show ATAK Contacts" toggle to the
 * Map Features panel and wired it through `MapContext`, but never extended the
 * persistence chain behind it — no column, no repository field, no route field.
 * The client POSTed `showAtakContacts` to `/api/user/map-preferences`, the
 * route's explicit destructure silently dropped it, and the save returned
 * `{ success: true }`. Every reload reset the toggle to its in-memory default
 * of `false` (#4378).
 *
 * Default FALSE, matching `MapContext`'s `useState(false)` and the #3691
 * "ATAK contacts are opt-in" decision, so a fresh row read agrees with what an
 * unconfigured user already sees. Contrast migration 074 (`show_waypoints`),
 * which defaults TRUE because that toggle is opt-out.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL via the shared helpers.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 129';
const TABLE = 'user_map_preferences';
const COLUMN = 'show_atak_contacts';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding ${TABLE}.${COLUMN}...`);
    addColumnIfMissing(db, TABLE, COLUMN, `${COLUMN} INTEGER DEFAULT 0`);
    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration129Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${TABLE}.${COLUMN}...`);
  await addColumnIfMissingPostgres(client, TABLE, COLUMN, `"${COLUMN}" BOOLEAN DEFAULT FALSE`);
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration129Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${TABLE}.${COLUMN}...`);
  await addColumnIfMissingMysql(pool, TABLE, COLUMN, `${COLUMN} BOOLEAN DEFAULT FALSE`);
  logger.info(`${LABEL} complete (MySQL)`);
}
