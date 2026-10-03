/**
 * Migration 192: `channel_database.protocol` (#5552).
 *
 *   protocol TEXT NOT NULL DEFAULT 'meshtastic' — 'meshtastic' | 'meshcore'.
 *
 * MeshCore virtual channels reuse `channel_database` (GLOBAL, no sourceId,
 * like the Meshtastic rows): a `meshcore` row holds a 16-byte channel secret
 * that server-side decrypt can use without any device carrying it. Every
 * existing row is Meshtastic, which the column default records, so no backfill
 * is needed and Meshtastic readers (which filter on 'meshtastic') see exactly
 * the rows they did before.
 *
 * Pure additive, idempotent `ADD COLUMN` on all three backends.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 192';
const TABLE = 'channel_database';
const COLUMN = 'protocol';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding ${COLUMN} to ${TABLE}...`);
    addColumnIfMissing(db, TABLE, COLUMN, `protocol TEXT NOT NULL DEFAULT 'meshtastic'`);
    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration192Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${COLUMN} to ${TABLE}...`);
  await addColumnIfMissingPostgres(client, TABLE, COLUMN, `"protocol" TEXT NOT NULL DEFAULT 'meshtastic'`);
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration192Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${COLUMN} to ${TABLE}...`);
  await addColumnIfMissingMysql(pool, TABLE, COLUMN, `protocol VARCHAR(16) NOT NULL DEFAULT 'meshtastic'`);
  logger.info(`${LABEL} complete (MySQL)`);
}
