/**
 * Migration 183: add `hop_limit`, `automation_key`, `broadcast_fingerprint` to `waypoints` (#5482).
 *
 * - `hop_limit` (nullable integer 0-7): the hop limit a waypoint is sent with.
 *   NULL means "inherit the node's configured LoRa hop limit", which is what
 *   every existing row gets. The value is capped at the node's own limit at
 *   send time, so a stored value can only shorten reach.
 * - `automation_key` (nullable text): set on waypoints owned by an Automation
 *   Engine `action.broadcastWaypoint` step, as `<automationId>:<waypointKey>`.
 *   It lets each run update the same waypoint id instead of minting a new one,
 *   across runs and restarts. NULL for every waypoint not made by an automation.
 * - `broadcast_fingerprint` (nullable text): a digest of the content the
 *   automation step last put on the air. `onlyWhenChanged` compares against it,
 *   not against the row, because a run skipped by the 30-minute floor still
 *   updates the row — comparing to the row would then hide that change forever.
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

const LABEL = 'Migration 183';
const TABLE = 'waypoints';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding ${TABLE}.hop_limit, automation_key, broadcast_fingerprint...`);
    addColumnIfMissing(db, TABLE, 'hop_limit', 'hop_limit INTEGER');
    addColumnIfMissing(db, TABLE, 'automation_key', 'automation_key TEXT');
    addColumnIfMissing(db, TABLE, 'broadcast_fingerprint', 'broadcast_fingerprint TEXT');
    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration183Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${TABLE}.hop_limit, automation_key, broadcast_fingerprint...`);
  await addColumnIfMissingPostgres(client, TABLE, 'hop_limit', '"hop_limit" INTEGER');
  await addColumnIfMissingPostgres(client, TABLE, 'automation_key', '"automation_key" TEXT');
  await addColumnIfMissingPostgres(client, TABLE, 'broadcast_fingerprint', '"broadcast_fingerprint" TEXT');
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration183Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${TABLE}.hop_limit, automation_key, broadcast_fingerprint...`);
  await addColumnIfMissingMysql(pool, TABLE, 'hop_limit', 'hop_limit INT');
  await addColumnIfMissingMysql(pool, TABLE, 'automation_key', 'automation_key VARCHAR(255)');
  await addColumnIfMissingMysql(pool, TABLE, 'broadcast_fingerprint', 'broadcast_fingerprint VARCHAR(64)');
  logger.info(`${LABEL} complete (MySQL)`);
}
