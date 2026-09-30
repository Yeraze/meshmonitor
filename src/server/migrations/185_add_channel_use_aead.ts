/**
 * Migration 185: `channels.useAead` (#5248 Phase 1, AEAD_CHANNELS_PLAN.md).
 *
 *   useAead BOOLEAN NOT NULL DEFAULT false
 *
 * Firmware `set_channel` replaces the whole ChannelSettings, so a channel edit
 * that rebuilds ChannelSettings without `use_aead` (field 8) turns AES-CCM off.
 * Storing the device-reported flag lets every edit send it back unchanged.
 *
 * Per-source like the rest of `channels`. Existing rows read `false`, which is
 * what every device reported before AEAD existed. Pure additive, idempotent
 * `ADD COLUMN` across SQLite / PostgreSQL / MySQL via the shared helpers.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 185';
const TABLE = 'channels';
const COLUMN = 'useAead';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding ${COLUMN} to ${TABLE}...`);
    addColumnIfMissing(db, TABLE, COLUMN, 'useAead INTEGER NOT NULL DEFAULT 0');
    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration185Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${COLUMN} to ${TABLE}...`);
  await addColumnIfMissingPostgres(client, TABLE, COLUMN, '"useAead" BOOLEAN NOT NULL DEFAULT false');
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration185Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${COLUMN} to ${TABLE}...`);
  await addColumnIfMissingMysql(pool, TABLE, COLUMN, 'useAead BOOLEAN NOT NULL DEFAULT false');
  logger.info(`${LABEL} complete (MySQL)`);
}
