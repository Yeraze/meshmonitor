/**
 * Migration 014: Fix missing columns in PG/MySQL baselines
 *
 * 1. messages.decrypted_by — PG/MySQL baselines omitted this column that the Drizzle schema expects.
 * 2. channel_database.enforceNameValidation — PG/MySQL baselines omitted this column.
 * 3. channel_database.sortOrder — PG/MySQL baselines omitted this column.
 *
 * SQLite already has all columns, so the SQLite migration is a safe no-op.
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

    await client.query('ALTER TABLE channel_database ADD COLUMN IF NOT EXISTS "enforceNameValidation" BOOLEAN NOT NULL DEFAULT false');
    logger.debug('Ensured enforceNameValidation exists on channel_database');

    await client.query('ALTER TABLE channel_database ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER NOT NULL DEFAULT 0');
    logger.debug('Ensured sortOrder exists on channel_database');
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
    // 1. messages.decrypted_by
    const [msgRows] = await pool.query(`
      SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'messages' AND COLUMN_NAME = 'decrypted_by'
    `);
    if (!Array.isArray(msgRows) || msgRows.length === 0) {
      await pool.query('ALTER TABLE messages ADD COLUMN decrypted_by VARCHAR(16)');
      logger.debug('Added decrypted_by to messages');
    } else {
      logger.debug('messages.decrypted_by already exists, skipping');
    }

    // 2. channel_database.enforceNameValidation
    const [envRows] = await pool.query(`
      SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'channel_database' AND COLUMN_NAME = 'enforceNameValidation'
    `);
    if (!Array.isArray(envRows) || envRows.length === 0) {
      await pool.query('ALTER TABLE channel_database ADD COLUMN enforceNameValidation BOOLEAN NOT NULL DEFAULT false');
      logger.debug('Added enforceNameValidation to channel_database');
    } else {
      logger.debug('channel_database.enforceNameValidation already exists, skipping');
    }

    // 3. channel_database.sortOrder
    const [soRows] = await pool.query(`
      SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'channel_database' AND COLUMN_NAME = 'sortOrder'
    `);
    if (!Array.isArray(soRows) || soRows.length === 0) {
      await pool.query('ALTER TABLE channel_database ADD COLUMN sortOrder INT NOT NULL DEFAULT 0');
      logger.debug('Added sortOrder to channel_database');
    } else {
      logger.debug('channel_database.sortOrder already exists, skipping');
    }
  } catch (error: any) {
    logger.error('Migration 014 (MySQL) failed:', error.message);
    throw error;
  }

  logger.info('Migration 014 complete (MySQL)');
}
