/**
 * Migration 166: add `mutedAt` to `mesh_beacon_offers` (#5232).
 *
 * `dismissedAt` hides an invitation until the advertising node changes what it
 * advertises — a deliberate choice, so a re-keyed channel is treated as a new
 * invitation rather than one already declined. But a neighbour that keeps
 * re-targeting its beacon can therefore keep re-surfacing, and on a phone two
 * such cards squeeze the message list to a sliver.
 *
 * `mutedAt` is the permanent form: it survives every rebroadcast AND every
 * content change, and only an explicit un-mute clears it. Two columns rather
 * than one flag because they answer different questions — "not now" and
 * "never" — and a user who muted a mesh should not have that silently undone
 * by the sender editing its own offer.
 *
 * Idempotent on all three backends via the shared column helpers.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { addColumnIfMissing, addColumnIfMissingPostgres, addColumnIfMissingMysql } from './helpers.js';

const LABEL = 'Migration 166';
const TABLE = 'mesh_beacon_offers';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding ${TABLE}.mutedAt...`);
    addColumnIfMissing(db, TABLE, 'mutedAt', 'mutedAt INTEGER');
    logger.info(`${LABEL} complete (SQLite)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration166Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${TABLE}.mutedAt...`);
  await addColumnIfMissingPostgres(client, TABLE, 'mutedAt', '"mutedAt" BIGINT');
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration166Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${TABLE}.mutedAt...`);
  await addColumnIfMissingMysql(pool, TABLE, 'mutedAt', 'mutedAt BIGINT');
  logger.info(`${LABEL} complete (MySQL)`);
}
