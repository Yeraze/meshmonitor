/**
 * Migration 101: Add isUnmessagable / isLicensed columns to the nodes table (#3684)
 *
 * The Meshtastic User protobuf carries two capability flags:
 *   - is_unmessagable (optional bool) — node will not receive direct messages
 *   - is_licensed     (bool)          — amateur-radio licensed operator
 *
 * These were never persisted, so the Config tab's "Unmessageable" checkbox for
 * the LOCAL node always rendered unchecked (the /admin/get-owner local branch
 * hardcoded both to false). We now ingest them from NodeInfo and store them per
 * node so the checkbox reflects the device's real setting.
 *
 * Both columns default to false / 0.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 101 (SQLite): Adding isUnmessagable/isLicensed to nodes...');

    for (const col of ['isUnmessagable', 'isLicensed']) {
      try {
        db.exec(`ALTER TABLE nodes ADD COLUMN ${col} INTEGER DEFAULT 0`);
        logger.debug(`Added nodes.${col}`);
      } catch (e: any) {
        if (e.message?.includes('duplicate column')) {
          logger.debug(`nodes.${col} already exists, skipping`);
        } else {
          logger.warn(`Could not add nodes.${col}:`, e.message);
        }
      }
    }

    logger.info('Migration 101 complete (SQLite): nodes.isUnmessagable/isLicensed added');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 101 down: Not implemented (destructive column drops)');
  }
};

// ============ PostgreSQL ============

export async function runMigration101Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info('Running migration 101 (PostgreSQL): Adding isUnmessagable/isLicensed to nodes...');

  try {
    await client.query('ALTER TABLE nodes ADD COLUMN IF NOT EXISTS "isUnmessagable" BOOLEAN DEFAULT FALSE');
    await client.query('ALTER TABLE nodes ADD COLUMN IF NOT EXISTS "isLicensed" BOOLEAN DEFAULT FALSE');
    logger.debug('Ensured nodes.isUnmessagable / nodes.isLicensed exist');
  } catch (error: any) {
    logger.error('Migration 101 (PostgreSQL) failed:', error.message);
    throw error;
  }

  logger.info('Migration 101 complete (PostgreSQL): nodes.isUnmessagable/isLicensed added');
}

// ============ MySQL ============

export async function runMigration101Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info('Running migration 101 (MySQL): Adding isUnmessagable/isLicensed to nodes...');

  try {
    for (const col of ['isUnmessagable', 'isLicensed']) {
      const [rows] = await pool.query(`
        SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nodes' AND COLUMN_NAME = ?
      `, [col]);
      if (!Array.isArray(rows) || rows.length === 0) {
        await pool.query(`ALTER TABLE nodes ADD COLUMN ${col} BOOLEAN DEFAULT FALSE`);
        logger.debug(`Added nodes.${col}`);
      } else {
        logger.debug(`nodes.${col} already exists, skipping`);
      }
    }
  } catch (error: any) {
    logger.error('Migration 101 (MySQL) failed:', error.message);
    throw error;
  }

  logger.info('Migration 101 complete (MySQL): nodes.isUnmessagable/isLicensed added');
}
