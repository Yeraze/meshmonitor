/**
 * Migration 237: `meshcore_nodes.lastRoomLoginOkAt` (#6408).
 *
 *   lastRoomLoginOkAt BIGINT NULL - epoch ms of the last SUCCESSFUL login to
 *   this room server from this source's companion.
 *
 * A MeshCore room server keeps an ACL of clients that logged in before, and a
 * blank-password login from a key already in that ACL gets back in with its
 * old permission. A non-NULL value here means "this source has joined that
 * room", which is what lets the Room Sync scheduler re-join with a blank
 * password when no password is saved. It stores no secret.
 *
 * `lastRoomSyncAt` cannot serve: the scheduler stamps it on every attempt,
 * failed ones included (#5036). Per-source like the rest of `meshcore_nodes`.
 * NULL for every existing row (not yet known to have joined). Additive and
 * idempotent on all three backends via the shared helpers.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 237';
const TABLE = 'meshcore_nodes';
const COLUMN = 'lastRoomLoginOkAt';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding ${COLUMN} to ${TABLE}...`);
    addColumnIfMissing(db, TABLE, COLUMN, 'lastRoomLoginOkAt INTEGER');
    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration237Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${COLUMN} to ${TABLE}...`);
  await addColumnIfMissingPostgres(client, TABLE, COLUMN, '"lastRoomLoginOkAt" BIGINT');
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration237Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${COLUMN} to ${TABLE}...`);
  await addColumnIfMissingMysql(pool, TABLE, COLUMN, 'lastRoomLoginOkAt BIGINT NULL');
  logger.info(`${LABEL} complete (MySQL)`);
}
