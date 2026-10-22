/**
 * Migration 217: nodes.channelLocked (#5923).
 *
 * `nodes.channel` is learned from traffic. #5926 stopped recording it from
 * evidence that isn't the node's own key-decoded traffic, but rows written
 * before that fix can still name a channel the node has no key for. An admin
 * can now set or clear a node's channel by hand and optionally lock it; while
 * locked, packet-driven upserts leave `channel` alone.
 *
 * Every existing row starts unlocked (default false), so traffic keeps
 * updating channels exactly as before until someone locks one. Idempotent
 * across SQLite / PostgreSQL / MySQL via the helpers.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 217';
const TABLE = 'nodes';
const COLUMN = 'channelLocked';

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

export async function runMigration217Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${TABLE}.${COLUMN}...`);
  await addColumnIfMissingPostgres(client, TABLE, COLUMN, `"${COLUMN}" BOOLEAN DEFAULT false`);
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration217Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${TABLE}.${COLUMN}...`);
  await addColumnIfMissingMysql(pool, TABLE, COLUMN, `${COLUMN} TINYINT(1) DEFAULT 0`);
  logger.info(`${LABEL} complete (MySQL)`);
}
