/**
 * Migration 164: `user_map_preferences.spread_nodes` (#5177).
 *
 * Low-precision nodes are rendered at a deterministic offset WITHIN their
 * accuracy cell rather than at the cell centre (#4016/#4155), so same-cell
 * markers declutter instead of stacking. A reporter compared a node's pin to
 * its reported GPS coordinates on OpenStreetMap and — correctly — read the
 * offset as the map lying about where the node is.
 *
 * Both readings are defensible, so it becomes a per-user choice:
 *
 *   spread_nodes  BOOLEAN  DEFAULT TRUE
 *
 * Defaulting TRUE preserves today's behaviour for everyone who has not asked
 * for anything different; unchecking it pins every node at exactly the
 * position it reported. Per-user rather than global, beside the other
 * display toggles (`show_mqtt_nodes` and friends) in this very table. NULL on
 * rows written before this migration reads as "not set", which the frontend
 * treats as enabled — matching the default.
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

const LABEL = 'Migration 164';
const TABLE = 'user_map_preferences';
const COLUMN = 'spread_nodes';

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

export async function runMigration164Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${TABLE}.${COLUMN}...`);
  await addColumnIfMissingPostgres(client, TABLE, COLUMN, `"${COLUMN}" BOOLEAN DEFAULT TRUE`);
}

// ============ MySQL ============

export async function runMigration164Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${TABLE}.${COLUMN}...`);
  await addColumnIfMissingMysql(pool, TABLE, COLUMN, `${COLUMN} BOOLEAN DEFAULT TRUE`);
}
