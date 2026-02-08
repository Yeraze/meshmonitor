/**
 * Migration 068: Add MFA (Multi-Factor Authentication) columns to users table
 *
 * Adds columns for TOTP-based two-factor authentication:
 * - mfa_enabled (boolean, default false) - whether MFA is active for the user
 * - mfa_secret (text, nullable) - base32-encoded TOTP secret
 * - mfa_backup_codes (text, nullable) - JSON array of bcrypt-hashed backup codes
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database): void => {
    logger.debug('Running migration 068: Add MFA columns to users table');

    try {
      // Check which columns already exist
      const columns = db.pragma("table_info('users')") as Array<{ name: string }>;
      const columnNames = new Set(columns.map((col) => col.name));

      if (!columnNames.has('mfa_enabled')) {
        db.exec(`ALTER TABLE users ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0`);
        logger.debug('Added mfa_enabled column to users table');
      } else {
        logger.debug('mfa_enabled column already exists, skipping');
      }

      if (!columnNames.has('mfa_secret')) {
        db.exec(`ALTER TABLE users ADD COLUMN mfa_secret TEXT`);
        logger.debug('Added mfa_secret column to users table');
      } else {
        logger.debug('mfa_secret column already exists, skipping');
      }

      if (!columnNames.has('mfa_backup_codes')) {
        db.exec(`ALTER TABLE users ADD COLUMN mfa_backup_codes TEXT`);
        logger.debug('Added mfa_backup_codes column to users table');
      } else {
        logger.debug('mfa_backup_codes column already exists, skipping');
      }

      logger.debug('Migration 068 completed: MFA columns added to users table');
    } catch (error) {
      logger.error('Migration 068 failed:', error);
      throw error;
    }
  },

  down: (_db: Database): void => {
    logger.debug('Running migration 068 down: Remove MFA columns from users table');

    try {
      // SQLite 3.35.0+ supports DROP COLUMN
      // For older versions, these columns will remain but won't be used
      logger.debug('Note: SQLite DROP COLUMN requires version 3.35.0+');
      logger.debug('The MFA columns will remain but will not be used');

      logger.debug('Migration 068 rollback completed');
    } catch (error) {
      logger.error('Migration 068 rollback failed:', error);
      throw error;
    }
  }
};

/**
 * PostgreSQL migration: Add MFA columns to users table
 */
export async function runMigration068Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.debug('Running migration 068 (PostgreSQL): Add MFA columns to users table');

  try {
    // Check and add mfa_enabled column
    const mfaEnabledExists = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'users'
          AND column_name = 'mfaEnabled'
      )
    `);

    if (!mfaEnabledExists.rows[0].exists) {
      await client.query(`ALTER TABLE users ADD COLUMN "mfaEnabled" BOOLEAN NOT NULL DEFAULT false`);
      logger.debug('Added mfaEnabled column to users table');
    } else {
      logger.debug('mfaEnabled column already exists, skipping');
    }

    // Check and add mfa_secret column
    const mfaSecretExists = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'users'
          AND column_name = 'mfaSecret'
      )
    `);

    if (!mfaSecretExists.rows[0].exists) {
      await client.query(`ALTER TABLE users ADD COLUMN "mfaSecret" TEXT`);
      logger.debug('Added mfaSecret column to users table');
    } else {
      logger.debug('mfaSecret column already exists, skipping');
    }

    // Check and add mfa_backup_codes column
    const mfaBackupCodesExists = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'users'
          AND column_name = 'mfaBackupCodes'
      )
    `);

    if (!mfaBackupCodesExists.rows[0].exists) {
      await client.query(`ALTER TABLE users ADD COLUMN "mfaBackupCodes" TEXT`);
      logger.debug('Added mfaBackupCodes column to users table');
    } else {
      logger.debug('mfaBackupCodes column already exists, skipping');
    }

    logger.debug('Migration 068 (PostgreSQL): MFA columns added to users table');
  } catch (error) {
    logger.error('Migration 068 (PostgreSQL) failed:', error);
    throw error;
  }
}

/**
 * MySQL migration: Add MFA columns to users table
 */
export async function runMigration068Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.debug('Running migration 068 (MySQL): Add MFA columns to users table');

  try {
    const connection = await pool.getConnection();
    try {
      // Check and add mfaEnabled column
      const [mfaEnabledCols] = await connection.query(`
        SELECT COLUMN_NAME FROM information_schema.columns
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'users'
          AND COLUMN_NAME = 'mfaEnabled'
      `);

      if ((mfaEnabledCols as any[]).length === 0) {
        await connection.query(`ALTER TABLE users ADD COLUMN mfaEnabled TINYINT(1) NOT NULL DEFAULT 0`);
        logger.debug('Added mfaEnabled column to users table');
      } else {
        logger.debug('mfaEnabled column already exists, skipping');
      }

      // Check and add mfaSecret column
      const [mfaSecretCols] = await connection.query(`
        SELECT COLUMN_NAME FROM information_schema.columns
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'users'
          AND COLUMN_NAME = 'mfaSecret'
      `);

      if ((mfaSecretCols as any[]).length === 0) {
        await connection.query(`ALTER TABLE users ADD COLUMN mfaSecret TEXT`);
        logger.debug('Added mfaSecret column to users table');
      } else {
        logger.debug('mfaSecret column already exists, skipping');
      }

      // Check and add mfaBackupCodes column
      const [mfaBackupCodesCols] = await connection.query(`
        SELECT COLUMN_NAME FROM information_schema.columns
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'users'
          AND COLUMN_NAME = 'mfaBackupCodes'
      `);

      if ((mfaBackupCodesCols as any[]).length === 0) {
        await connection.query(`ALTER TABLE users ADD COLUMN mfaBackupCodes TEXT`);
        logger.debug('Added mfaBackupCodes column to users table');
      } else {
        logger.debug('mfaBackupCodes column already exists, skipping');
      }

      logger.debug('Migration 068 (MySQL): MFA columns added to users table');
    } finally {
      connection.release();
    }
  } catch (error) {
    logger.error('Migration 068 (MySQL) failed:', error);
    throw error;
  }
}
