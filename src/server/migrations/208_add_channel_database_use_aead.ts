/**
 * Migration 208: `channel_database.useAead` (#5248 Phase 2, AEAD_CHANNELS_PLAN.md).
 *
 *   SQLite:      use_aead INTEGER NOT NULL DEFAULT 0
 *   PostgreSQL:  "useAead" BOOLEAN NOT NULL DEFAULT false
 *   MySQL:       useAead BOOLEAN NOT NULL DEFAULT false
 *
 * Marks a server-side decryption key as an AES-CCM (AEAD) channel, so the
 * decryption service uses the CCM path and the `^ 0xAE` channel hash for it.
 * Global like the rest of `channel_database`. Existing rows read `false`, the
 * only mode that existed before firmware 2.8.1. Pure additive, idempotent
 * `ADD COLUMN` via the shared helpers; no backfill (enabled rows compute their
 * hash from name + key, so there is no stored hash to update).
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 208';
const TABLE = 'channel_database';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding use_aead to ${TABLE}...`);
    addColumnIfMissing(db, TABLE, 'use_aead', 'use_aead INTEGER NOT NULL DEFAULT 0');
    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration208Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding useAead to ${TABLE}...`);
  await addColumnIfMissingPostgres(client, TABLE, 'useAead', '"useAead" BOOLEAN NOT NULL DEFAULT false');
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration208Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding useAead to ${TABLE}...`);
  await addColumnIfMissingMysql(pool, TABLE, 'useAead', 'useAead BOOLEAN NOT NULL DEFAULT false');
  logger.info(`${LABEL} complete (MySQL)`);
}
