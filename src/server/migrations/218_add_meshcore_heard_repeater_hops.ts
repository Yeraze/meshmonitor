/**
 * Migration 218: meshcore_heard_repeaters.hops (#6000).
 *
 * MeshCore flood packets append each relay's hash to `path[]` in order, so a
 * repeater's index in the echoed copy's relay chain is how many hops it sat
 * from the sender when it relayed our channel message (path [A,B]: A=0, B=1).
 * The heard-repeaters list shows that count per repeater.
 *
 * Nullable with no default: rows written before this migration have no hop
 * data and stay null (the UI sorts them last). Idempotent across SQLite /
 * PostgreSQL / MySQL via the helpers.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 218';
const TABLE = 'meshcore_heard_repeaters';
const COLUMN = 'hops';

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

export async function runMigration218Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${TABLE}.${COLUMN}...`);
  await addColumnIfMissingPostgres(client, TABLE, COLUMN, `"${COLUMN}" INTEGER`);
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration218Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${TABLE}.${COLUMN}...`);
  await addColumnIfMissingMysql(pool, TABLE, COLUMN, `${COLUMN} INT`);
  logger.info(`${LABEL} complete (MySQL)`);
}
