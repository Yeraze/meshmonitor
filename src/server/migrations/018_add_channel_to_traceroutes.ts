/**
 * Migration 018: Add channel column to traceroutes table
 *
 * Traceroute packets arrive on a specific mesh channel. This column records
 * that channel index so the API can enforce the same private-channel masking
 * pattern used for position data (see nodeEnhancer.ts).
 *
 * NULL indicates the channel was not captured (pre-migration rows).
 *
 * Related: MM-47
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 018 (SQLite): Adding channel column to traceroutes...');

    try {
      db.exec('ALTER TABLE traceroutes ADD COLUMN channel INTEGER');
      logger.debug('Added channel column to traceroutes');
    } catch (e: any) {
      if (e.message?.includes('duplicate column')) {
        logger.debug('traceroutes.channel already exists, skipping');
      } else {
        logger.warn('Could not add channel to traceroutes:', e.message);
      }
    }

    logger.info('Migration 018 complete (SQLite): traceroutes.channel added');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 018 down: Not implemented (destructive column drops)');
  }
};

// ============ PostgreSQL ============

export async function runMigration018Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info('Running migration 018 (PostgreSQL): Adding channel to traceroutes...');

  try {
    await client.query('ALTER TABLE traceroutes ADD COLUMN IF NOT EXISTS channel INTEGER');
    logger.debug('Ensured traceroutes.channel exists');
  } catch (error: any) {
    logger.error('Migration 018 (PostgreSQL) failed:', error.message);
    throw error;
  }

  logger.info('Migration 018 complete (PostgreSQL): traceroutes.channel added');
}

// ============ MySQL ============

export async function runMigration018Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info('Running migration 018 (MySQL): Adding channel to traceroutes...');

  try {
    const [rows] = await pool.query(`
      SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'traceroutes' AND COLUMN_NAME = 'channel'
    `);
    if (!Array.isArray(rows) || rows.length === 0) {
      await pool.query('ALTER TABLE traceroutes ADD COLUMN channel INT');
      logger.debug('Added channel to traceroutes');
    } else {
      logger.debug('traceroutes.channel already exists, skipping');
    }
  } catch (error: any) {
    logger.error('Migration 018 (MySQL) failed:', error.message);
    throw error;
  }

  logger.info('Migration 018 complete (MySQL): traceroutes.channel added');
}
