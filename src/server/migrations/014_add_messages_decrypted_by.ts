/**
 * Migration 014: Add missing decrypted_by column to messages table for PostgreSQL/MySQL
 *
 * The Drizzle schema defines decryptedBy on messages for all backends, and the
 * SQLite baseline includes it, but the PostgreSQL and MySQL baselines omit it.
 * This causes DrizzleQueryError on any SELECT from the messages table.
 *
 * SQLite already has the column, so the SQLite migration is a safe no-op.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 014 (SQLite): Ensuring decrypted_by on messages...');

    try {
      db.exec('ALTER TABLE messages ADD COLUMN decrypted_by TEXT');
      logger.debug('Added decrypted_by column to messages');
    } catch (e: any) {
      if (e.message?.includes('duplicate column')) {
        logger.debug('messages.decrypted_by already exists, skipping');
      } else {
        logger.warn('Could not add decrypted_by to messages:', e.message);
      }
    }

    logger.info('Migration 014 complete (SQLite)');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 014 down: Not implemented');
  }
};

// ============ PostgreSQL ============

export async function runMigration014Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info('Running migration 014 (PostgreSQL): Adding decrypted_by to messages...');

  try {
    await client.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS decrypted_by TEXT');
    logger.debug('Ensured decrypted_by exists on messages');
  } catch (error: any) {
    logger.error('Migration 014 (PostgreSQL) failed:', error.message);
    throw error;
  }

  logger.info('Migration 014 complete (PostgreSQL)');
}

// ============ MySQL ============

export async function runMigration014Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info('Running migration 014 (MySQL): Adding decrypted_by to messages...');

  try {
    const [rows] = await pool.query(`
      SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'messages' AND COLUMN_NAME = 'decrypted_by'
    `);
    if (!Array.isArray(rows) || rows.length === 0) {
      await pool.query('ALTER TABLE messages ADD COLUMN decrypted_by VARCHAR(16)');
      logger.debug('Added decrypted_by to messages');
    } else {
      logger.debug('messages.decrypted_by already exists, skipping');
    }
  } catch (error: any) {
    logger.error('Migration 014 (MySQL) failed:', error.message);
    throw error;
  }

  logger.info('Migration 014 complete (MySQL)');
}
