/**
 * Migration 149: add `nodeStatus` + `nodeStatusUpdatedAt` columns to `nodes`
 * (Status Message receive side, #4818).
 *
 * The firmware `StatusMessageModule` (fw 2.7.20+/2.8.0) broadcasts each node's
 * self-set status on `PortNum.NODE_STATUS_APP` (36) as
 * `meshtastic.StatusMessage { string status }` (max 80 chars) — on change, and
 * otherwise ~every 12h. MeshMonitor now decodes and stores it as a per-node
 * attribute (one current value, cleared to NULL on an empty broadcast),
 * mirroring the official Android/Apple clients. Meshtastic-only.
 *
 * Both columns are nullable. Idempotent across SQLite / PostgreSQL / MySQL via
 * the shared helpers.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 149';
const TABLE = 'nodes';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding node-status columns to ${TABLE}...`);
    addColumnIfMissing(db, TABLE, 'nodeStatus', 'nodeStatus TEXT');
    addColumnIfMissing(db, TABLE, 'nodeStatusUpdatedAt', 'nodeStatusUpdatedAt INTEGER');
    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration149Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding node-status columns to ${TABLE}...`);
  await addColumnIfMissingPostgres(client, TABLE, 'nodeStatus', '"nodeStatus" TEXT');
  await addColumnIfMissingPostgres(client, TABLE, 'nodeStatusUpdatedAt', '"nodeStatusUpdatedAt" BIGINT');
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration149Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding node-status columns to ${TABLE}...`);
  await addColumnIfMissingMysql(pool, TABLE, 'nodeStatus', 'nodeStatus VARCHAR(80)');
  await addColumnIfMissingMysql(pool, TABLE, 'nodeStatusUpdatedAt', 'nodeStatusUpdatedAt BIGINT');
  logger.info(`${LABEL} complete (MySQL)`);
}
