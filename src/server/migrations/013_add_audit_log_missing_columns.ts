/**
 * Migration 013: Add missing columns to audit_log for pre-3.7 SQLite databases
 *
 * The Drizzle schema expects ip_address and user_agent columns on audit_log,
 * but databases created before the v3.7 baseline may not have them.
 * Migration 012 added username but missed these two.
 *
 * PostgreSQL/MySQL baselines already include these columns, so those are no-ops.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 013 (SQLite): Adding missing audit_log columns...');

    // 1. Add ip_address to audit_log
    try {
      db.exec('ALTER TABLE audit_log ADD COLUMN ip_address TEXT');
      logger.debug('Added ip_address column to audit_log');
    } catch (e: any) {
      if (e.message?.includes('duplicate column')) {
        logger.debug('audit_log.ip_address already exists, skipping');
      } else {
        logger.warn('Could not add ip_address to audit_log:', e.message);
      }
    }

    // 2. Add user_agent to audit_log
    try {
      db.exec('ALTER TABLE audit_log ADD COLUMN user_agent TEXT');
      logger.debug('Added user_agent column to audit_log');
    } catch (e: any) {
      if (e.message?.includes('duplicate column')) {
        logger.debug('audit_log.user_agent already exists, skipping');
      } else {
        logger.warn('Could not add user_agent to audit_log:', e.message);
      }
    }

    logger.info('Migration 013 complete (SQLite): audit_log columns aligned');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 013 down: Not implemented (destructive column drops)');
  }
};

// ============ PostgreSQL ============

export async function runMigration013Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info('Running migration 013 (PostgreSQL): Ensuring audit_log columns exist...');

  try {
    await client.query('ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS "ipAddress" TEXT');
    await client.query('ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS "userAgent" TEXT');
    logger.debug('Ensured ipAddress/userAgent exist on audit_log');
  } catch (error: any) {
    logger.error('Migration 013 (PostgreSQL) failed:', error.message);
    throw error;
  }

  logger.info('Migration 013 complete (PostgreSQL): audit_log columns aligned');
}

// ============ MySQL ============

export async function runMigration013Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info('Running migration 013 (MySQL): Ensuring audit_log columns exist...');

  try {
    const [ipRows] = await pool.query(`
      SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_log' AND COLUMN_NAME = 'ipAddress'
    `);
    if (!Array.isArray(ipRows) || ipRows.length === 0) {
      await pool.query('ALTER TABLE audit_log ADD COLUMN ipAddress TEXT');
      logger.debug('Added ipAddress to audit_log');
    } else {
      logger.debug('audit_log.ipAddress already exists, skipping');
    }

    const [uaRows] = await pool.query(`
      SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_log' AND COLUMN_NAME = 'userAgent'
    `);
    if (!Array.isArray(uaRows) || uaRows.length === 0) {
      await pool.query('ALTER TABLE audit_log ADD COLUMN userAgent TEXT');
      logger.debug('Added userAgent to audit_log');
    } else {
      logger.debug('audit_log.userAgent already exists, skipping');
    }
  } catch (error: any) {
    logger.error('Migration 013 (MySQL) failed:', error.message);
    throw error;
  }

  logger.info('Migration 013 complete (MySQL): audit_log columns aligned');
}
