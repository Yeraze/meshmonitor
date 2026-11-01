/**
 * Migration 221: `user_map_preferences.color_nodes_by_source` (#6125).
 *
 * On cross-source (Unified) maps every node marker is coloured by role and
 * faded by age, so there is no way to tell which source a node arrived
 * through. This adds an opt-in per-user toggle:
 *
 *   color_nodes_by_source  BOOLEAN  DEFAULT FALSE
 *
 * When on, the Dashboard Unified map draws a per-source coloured ring around
 * each node marker (reusing `getSourceColor`, so the ring matches the colour
 * that source already uses in Unified Messages/Telemetry, flight lines, and
 * legends). Default FALSE keeps today's behaviour; the ring is opt-in. NULL on
 * a pre-migration row reads as "not set", which the frontend treats as off —
 * matching the default.
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

const LABEL = 'Migration 221';
const TABLE = 'user_map_preferences';
const COLUMN = 'color_nodes_by_source';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding ${TABLE}.${COLUMN}...`);
    addColumnIfMissing(db, TABLE, COLUMN, `${COLUMN} INTEGER DEFAULT 0`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration221Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${TABLE}.${COLUMN}...`);
  await addColumnIfMissingPostgres(client, TABLE, COLUMN, `"${COLUMN}" BOOLEAN DEFAULT FALSE`);
}

// ============ MySQL ============

export async function runMigration221Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${TABLE}.${COLUMN}...`);
  await addColumnIfMissingMysql(pool, TABLE, COLUMN, `${COLUMN} BOOLEAN DEFAULT FALSE`);
}
