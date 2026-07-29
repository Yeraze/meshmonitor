/**
 * Migration 130: Add `channel` column to `waypoints` (#4341).
 *
 * Waypoints used to go out on the implicit default channel slot 0 — the
 * `options.channel ?? 0` fallback in `meshtasticManager.broadcastWaypoint`.
 * The editor now lets the user pick the broadcast channel, and that choice has
 * to survive a reload and be reused by the rebroadcast scheduler, so it needs
 * a column.
 *
 * NULL means "not chosen" and every read site falls back to 0, so existing
 * rows keep today's behaviour exactly.
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

const LABEL = 'Migration 130';
const TABLE = 'waypoints';
const COLUMN = 'channel';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding ${TABLE}.${COLUMN}...`);
    addColumnIfMissing(db, TABLE, COLUMN, `${COLUMN} INTEGER`);
    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration130Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${TABLE}.${COLUMN}...`);
  await addColumnIfMissingPostgres(client, TABLE, COLUMN, `"${COLUMN}" INTEGER`);
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration130Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${TABLE}.${COLUMN}...`);
  await addColumnIfMissingMysql(pool, TABLE, COLUMN, `${COLUMN} INT`);
  logger.info(`${LABEL} complete (MySQL)`);
}
