/**
 * Migration 063: Drop `sourceId` column from `channel_database`.
 *
 * Migration 021 added `sourceId` to every data table, but `channel_database`
 * is the one table where source-scoping never materialized: the repository
 * never filters by `sourceId`, all routes call `createAsync` without a source,
 * and `channelDecryptionService` keeps a single global cache pulled from
 * `getEnabledAsync()`. Both Meshtastic and (post-3089) MQTT decrypt against
 * that same global set. The column is dead weight and the UI is moving from
 * per-source Device Configuration to Global Settings to match the runtime
 * behaviour.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 063';
const TABLE = 'channel_database';
const COLUMN = 'sourceId';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): dropping ${TABLE}.${COLUMN}...`);
    try {
      db.exec(`ALTER TABLE ${TABLE} DROP COLUMN ${COLUMN}`);
      logger.debug(`${LABEL} (SQLite): dropped ${TABLE}.${COLUMN}`);
    } catch (e: any) {
      if (e.message?.includes('no such column')) {
        logger.debug(`${LABEL} (SQLite): ${TABLE}.${COLUMN} already absent, skipping`);
      } else {
        logger.error(`${LABEL} (SQLite): could not drop ${TABLE}.${COLUMN}:`, e.message);
        throw e;
      }
    }
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration063Postgres(client: any): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): dropping ${TABLE}.${COLUMN}...`);
  await client.query(`ALTER TABLE ${TABLE} DROP COLUMN IF EXISTS "${COLUMN}"`);
  logger.debug(`${LABEL} (PostgreSQL): ensured ${TABLE}.${COLUMN} is dropped`);
}

// ============ MySQL ============

export async function runMigration063Mysql(pool: any): Promise<void> {
  logger.info(`${LABEL} (MySQL): dropping ${TABLE}.${COLUMN}...`);
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [TABLE, COLUMN],
    );
    if (Array.isArray(rows) && rows.length > 0) {
      await conn.query(`ALTER TABLE ${TABLE} DROP COLUMN ${COLUMN}`);
      logger.debug(`${LABEL} (MySQL): dropped ${TABLE}.${COLUMN}`);
    } else {
      logger.debug(`${LABEL} (MySQL): ${TABLE}.${COLUMN} already absent, skipping`);
    }
  } finally {
    conn.release();
  }
}
