/**
 * Migration 251: `meshcore_nodes.lastRoomClearAt` (#6579).
 *
 *   lastRoomClearAt BIGINT NULL - epoch ms of the last "Clear stored posts &
 *   re-sync" on this room server from this source.
 *
 * Two jobs, both reasons it must live in the database and not in memory:
 *   - The 30-minute cooldown on the action. A restart or a settings save must
 *     never re-arm it (CLAUDE.md, "Does a save reset a safety timer?").
 *   - Room Sync owes the room one login while this is newer than the last
 *     login, and posts stamped before it arrive quietly (no notification, no
 *     automation): they are old posts being pulled again.
 *
 * Per-source like the rest of `meshcore_nodes`. NULL for every existing row.
 * Additive and idempotent on all three backends via the shared helpers.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 251';
const TABLE = 'meshcore_nodes';
const COLUMN = 'lastRoomClearAt';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding ${COLUMN} to ${TABLE}...`);
    addColumnIfMissing(db, TABLE, COLUMN, 'lastRoomClearAt INTEGER');
    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration251Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${COLUMN} to ${TABLE}...`);
  await addColumnIfMissingPostgres(client, TABLE, COLUMN, '"lastRoomClearAt" BIGINT');
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration251Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${COLUMN} to ${TABLE}...`);
  await addColumnIfMissingMysql(pool, TABLE, COLUMN, 'lastRoomClearAt BIGINT NULL');
  logger.info(`${LABEL} complete (MySQL)`);
}
