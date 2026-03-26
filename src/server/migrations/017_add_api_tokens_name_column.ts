/**
 * Migration 017: Add missing columns to api_tokens table
 *
 * Pre-3.7 databases created api_tokens without the `name` and `expires_at`
 * columns. The v3.7 baseline uses CREATE TABLE IF NOT EXISTS, which doesn't
 * alter existing tables. This migration adds the missing columns.
 *
 * Fixes: https://github.com/Yeraze/meshmonitor/issues/2435
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 017 (SQLite): Adding missing api_tokens columns...');

    // Add name column (default to 'API Token' for existing rows)
    try {
      db.exec("ALTER TABLE api_tokens ADD COLUMN name TEXT NOT NULL DEFAULT 'API Token'");
      logger.debug('Added name column to api_tokens');
    } catch (e: any) {
      if (e.message?.includes('duplicate column')) {
        logger.debug('api_tokens.name already exists, skipping');
      } else {
        logger.warn('Could not add name to api_tokens:', e.message);
      }
    }

    // Add expires_at column
    try {
      db.exec('ALTER TABLE api_tokens ADD COLUMN expires_at INTEGER');
      logger.debug('Added expires_at column to api_tokens');
    } catch (e: any) {
      if (e.message?.includes('duplicate column')) {
        logger.debug('api_tokens.expires_at already exists, skipping');
      } else {
        logger.warn('Could not add expires_at to api_tokens:', e.message);
      }
    }

    logger.info('Migration 017 complete (SQLite): api_tokens columns aligned');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 017 down: Not implemented (destructive column drops)');
  }
};

// ============ PostgreSQL ============

export async function runMigration017Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info('Running migration 017 (PostgreSQL): Ensuring api_tokens columns exist...');

  try {
    await client.query("ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT 'API Token'");
    await client.query('ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS "expiresAt" BIGINT');
    logger.debug('Ensured name/expiresAt exist on api_tokens');
  } catch (error: any) {
    logger.error('Migration 017 (PostgreSQL) failed:', error.message);
    throw error;
  }

  logger.info('Migration 017 complete (PostgreSQL): api_tokens columns aligned');
}

// ============ MySQL ============

export async function runMigration017Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info('Running migration 017 (MySQL): Ensuring api_tokens columns exist...');

  try {
    const [nameRows] = await pool.query(`
      SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'api_tokens' AND COLUMN_NAME = 'name'
    `);
    if (!Array.isArray(nameRows) || nameRows.length === 0) {
      await pool.query("ALTER TABLE api_tokens ADD COLUMN name VARCHAR(255) NOT NULL DEFAULT 'API Token'");
      logger.debug('Added name to api_tokens');
    } else {
      logger.debug('api_tokens.name already exists, skipping');
    }

    const [expiresRows] = await pool.query(`
      SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'api_tokens' AND COLUMN_NAME = 'expiresAt'
    `);
    if (!Array.isArray(expiresRows) || expiresRows.length === 0) {
      await pool.query('ALTER TABLE api_tokens ADD COLUMN expiresAt BIGINT');
      logger.debug('Added expiresAt to api_tokens');
    } else {
      logger.debug('api_tokens.expiresAt already exists, skipping');
    }
  } catch (error: any) {
    logger.error('Migration 017 (MySQL) failed:', error.message);
    throw error;
  }

  logger.info('Migration 017 complete (MySQL): api_tokens columns aligned');
}
