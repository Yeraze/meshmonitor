/**
 * Migration 150: add `routingErrorCode` to `messages` (#4816 Phase 2).
 *
 * Persists the exact numeric Meshtastic RoutingError reason on the message
 * row that failed, so the Delivery Details popup can show e.g.
 * `MAX_RETRANSMIT (5)` with a "Reported by protocol" badge instead of the
 * generic Unknown placeholder. Rows predating this migration (and successful
 * deliveries, which never write this column) stay NULL — distinct from `0`
 * (RoutingError.NONE), which is a real success code and is never written on
 * the failed path.
 *
 * Nullable INTEGER, no default. Idempotent across SQLite / PostgreSQL /
 * MySQL via the shared helpers.
 *
 * Implements: https://github.com/Yeraze/meshmonitor/issues/4816
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 150';
const TABLE = 'messages';
const COLUMN = 'routingErrorCode';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding ${COLUMN} to ${TABLE}...`);
    addColumnIfMissing(db, TABLE, COLUMN, `${COLUMN} INTEGER`);
    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration150Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${COLUMN} to ${TABLE}...`);
  await addColumnIfMissingPostgres(client, TABLE, COLUMN, `"${COLUMN}" INTEGER`);
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration150Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${COLUMN} to ${TABLE}...`);
  await addColumnIfMissingMysql(pool, TABLE, COLUMN, `${COLUMN} INT`);
  logger.info(`${LABEL} complete (MySQL)`);
}
