/**
 * Migration 200: manual aircraft mark columns on `nodes` (#5715).
 *
 *   aircraftManualMark   TEXT    NULL — 'not_aircraft' | 'aircraft'; null = no manual mark
 *   aircraftManualMarkAt INTEGER NULL — ms epoch the user set the mark
 *   aircraftManualMarkBy INTEGER NULL — users.id of who set it (null if unknown)
 *
 * Why new columns: the existing `aircraftFixed*` anchor (migration 177) holds
 * the "not aircraft" position, but nothing in it says whether the age-out
 * sweep or a person set it, and every other aircraft column is rewritten by
 * the classifier on each pass, so a manual "aircraft" verdict has nowhere to
 * live. A "not_aircraft" mark still keeps its anchor in `aircraftFixed*`.
 *
 * No DEFAULT, no index. `upsertNode` never writes these columns; only the
 * aircraft repository methods do. Pure additive, idempotent `ADD COLUMN`
 * across SQLite / PostgreSQL / MySQL via the shared helpers (full DDL).
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 200';
const TABLE = 'nodes';

const COLS_SQLITE = [
  ['aircraftManualMark', 'aircraftManualMark TEXT'],
  ['aircraftManualMarkAt', 'aircraftManualMarkAt INTEGER'],
  ['aircraftManualMarkBy', 'aircraftManualMarkBy INTEGER'],
] as const;

const COLS_PG = [
  ['aircraftManualMark', '"aircraftManualMark" TEXT'],
  ['aircraftManualMarkAt', '"aircraftManualMarkAt" BIGINT'],
  ['aircraftManualMarkBy', '"aircraftManualMarkBy" INTEGER'],
] as const;

const COLS_MYSQL = [
  ['aircraftManualMark', 'aircraftManualMark VARCHAR(16)'],
  ['aircraftManualMarkAt', 'aircraftManualMarkAt BIGINT'],
  ['aircraftManualMarkBy', 'aircraftManualMarkBy INT'],
] as const;

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding aircraft manual-mark columns to ${TABLE}...`);
    for (const [column, ddl] of COLS_SQLITE) {
      addColumnIfMissing(db, TABLE, column, ddl);
    }
    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration200Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding aircraft manual-mark columns to ${TABLE}...`);
  for (const [column, ddl] of COLS_PG) {
    await addColumnIfMissingPostgres(client, TABLE, column, ddl);
  }
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration200Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding aircraft manual-mark columns to ${TABLE}...`);
  for (const [column, ddl] of COLS_MYSQL) {
    await addColumnIfMissingMysql(pool, TABLE, column, ddl);
  }
  logger.info(`${LABEL} complete (MySQL)`);
}
