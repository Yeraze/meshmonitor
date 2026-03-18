/**
 * Migration 012: Align auth schema across all three backends
 *
 * SQLite fixes:
 *   - Add updated_at column to users table
 *   - Add can_delete column to permissions table
 *   - Rename auth_provider to authMethod in users table
 *   - Add notify_on_channel_message to user_notification_preferences
 *
 * PostgreSQL/MySQL fixes:
 *   - Add grantedAt/grantedBy columns to permissions table
 *   - Upgrade neighbor_info.snr from REAL to DOUBLE PRECISION (PG only)
 *   - Upgrade backup_history.fileSize from INTEGER to BIGINT
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 012 (SQLite): Aligning auth schema...');

    // 1. Add updated_at to users
    try {
      db.exec('ALTER TABLE users ADD COLUMN updated_at INTEGER');
      logger.debug('Added updated_at column to users');
    } catch (e: any) {
      if (e.message?.includes('duplicate column')) {
        logger.debug('users.updated_at already exists, skipping');
      } else {
        logger.warn('Could not add updated_at to users:', e.message);
      }
    }

    // 2. Add can_delete to permissions
    try {
      db.exec('ALTER TABLE permissions ADD COLUMN can_delete INTEGER NOT NULL DEFAULT 0');
      logger.debug('Added can_delete column to permissions');
    } catch (e: any) {
      if (e.message?.includes('duplicate column')) {
        logger.debug('permissions.can_delete already exists, skipping');
      } else {
        logger.warn('Could not add can_delete to permissions:', e.message);
      }
    }

    // 3. Add can_view_on_map to permissions (if missing)
    try {
      db.exec('ALTER TABLE permissions ADD COLUMN can_view_on_map INTEGER NOT NULL DEFAULT 0');
      logger.debug('Added can_view_on_map column to permissions');
    } catch (e: any) {
      if (e.message?.includes('duplicate column')) {
        logger.debug('permissions.can_view_on_map already exists, skipping');
      } else {
        logger.warn('Could not add can_view_on_map to permissions:', e.message);
      }
    }

    // 4. Rename auth_provider to authMethod in users
    // SQLite 3.25+ supports RENAME COLUMN (better-sqlite3 uses 3.40+)
    try {
      // Check if auth_provider column exists
      const columns = db.pragma('table_info(users)') as Array<{ name: string }>;
      const hasAuthProvider = columns.some(c => c.name === 'auth_provider');
      const hasAuthMethod = columns.some(c => c.name === 'authMethod');

      if (hasAuthProvider && !hasAuthMethod) {
        db.exec('ALTER TABLE users RENAME COLUMN auth_provider TO authMethod');
        logger.debug('Renamed auth_provider to authMethod in users');
      } else if (hasAuthMethod) {
        logger.debug('users.authMethod already exists, skipping rename');
      } else {
        logger.debug('users.auth_provider not found, skipping rename');
      }
    } catch (e: any) {
      logger.warn('Could not rename auth_provider to authMethod:', e.message);
    }

    // 5. Add notify_on_channel_message to user_notification_preferences
    try {
      db.exec('ALTER TABLE user_notification_preferences ADD COLUMN notify_on_channel_message INTEGER NOT NULL DEFAULT 1');
      logger.debug('Added notify_on_channel_message to user_notification_preferences');
    } catch (e: any) {
      if (e.message?.includes('duplicate column')) {
        logger.debug('user_notification_preferences.notify_on_channel_message already exists, skipping');
      } else {
        logger.warn('Could not add notify_on_channel_message to user_notification_preferences:', e.message);
      }
    }

    logger.info('Migration 012 complete (SQLite): Auth schema aligned');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 012 down: Not implemented (destructive column drops)');
  }
};

// ============ PostgreSQL ============

export async function runMigration012Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info('Running migration 012 (PostgreSQL): Aligning auth schema...');

  try {
    // 1. Add grantedAt/grantedBy to permissions
    await client.query('ALTER TABLE permissions ADD COLUMN IF NOT EXISTS "grantedAt" BIGINT');
    await client.query('ALTER TABLE permissions ADD COLUMN IF NOT EXISTS "grantedBy" INTEGER');
    logger.debug('Ensured grantedAt/grantedBy exist on permissions');

    // 2. Fix neighbor_info.snr type (REAL -> DOUBLE PRECISION)
    const snrCheck = await client.query(`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'neighbor_info' AND column_name = 'snr'
    `);

    if (snrCheck.rows.length > 0 && snrCheck.rows[0].data_type !== 'double precision') {
      await client.query('ALTER TABLE neighbor_info ALTER COLUMN snr TYPE DOUBLE PRECISION');
      logger.debug('Upgraded neighbor_info.snr to DOUBLE PRECISION');
    } else {
      logger.debug('neighbor_info.snr already correct or table missing, skipping');
    }

    // 3. Fix backup_history.fileSize type (INTEGER -> BIGINT)
    const fileSizeCheck = await client.query(`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'backup_history' AND column_name = 'fileSize'
    `);

    if (fileSizeCheck.rows.length > 0 && fileSizeCheck.rows[0].data_type !== 'bigint') {
      await client.query('ALTER TABLE backup_history ALTER COLUMN "fileSize" TYPE BIGINT');
      logger.debug('Upgraded backup_history.fileSize to BIGINT');
    } else {
      logger.debug('backup_history.fileSize already correct or table missing, skipping');
    }
  } catch (error: any) {
    logger.error('Migration 012 (PostgreSQL) failed:', error.message);
    throw error;
  }

  logger.info('Migration 012 complete (PostgreSQL): Auth schema aligned');
}

// ============ MySQL ============

export async function runMigration012Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info('Running migration 012 (MySQL): Aligning auth schema...');

  try {
    // 1. Add grantedAt/grantedBy to permissions
    const [grantedAtRows] = await pool.query(`
      SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'permissions' AND COLUMN_NAME = 'grantedAt'
    `);
    if (!Array.isArray(grantedAtRows) || grantedAtRows.length === 0) {
      await pool.query('ALTER TABLE permissions ADD COLUMN grantedAt BIGINT');
      logger.debug('Added grantedAt to permissions');
    } else {
      logger.debug('permissions.grantedAt already exists, skipping');
    }

    const [grantedByRows] = await pool.query(`
      SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'permissions' AND COLUMN_NAME = 'grantedBy'
    `);
    if (!Array.isArray(grantedByRows) || grantedByRows.length === 0) {
      await pool.query('ALTER TABLE permissions ADD COLUMN grantedBy INTEGER');
      logger.debug('Added grantedBy to permissions');
    } else {
      logger.debug('permissions.grantedBy already exists, skipping');
    }

    // 2. Fix neighbor_info.snr type (FLOAT -> DOUBLE)
    const [snrRows] = await pool.query(`
      SELECT DATA_TYPE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'neighbor_info' AND COLUMN_NAME = 'snr'
    `);
    if (Array.isArray(snrRows) && snrRows.length > 0 && (snrRows[0] as any).DATA_TYPE !== 'double') {
      await pool.query('ALTER TABLE neighbor_info MODIFY COLUMN snr DOUBLE');
      logger.debug('Upgraded neighbor_info.snr to DOUBLE');
    } else {
      logger.debug('neighbor_info.snr already correct or table missing, skipping');
    }

    // 3. Fix backup_history.fileSize type (INT -> BIGINT)
    const [fileSizeRows] = await pool.query(`
      SELECT DATA_TYPE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'backup_history' AND COLUMN_NAME = 'fileSize'
    `);
    if (Array.isArray(fileSizeRows) && fileSizeRows.length > 0 && (fileSizeRows[0] as any).DATA_TYPE !== 'bigint') {
      await pool.query('ALTER TABLE backup_history MODIFY COLUMN fileSize BIGINT');
      logger.debug('Upgraded backup_history.fileSize to BIGINT');
    } else {
      logger.debug('backup_history.fileSize already correct or table missing, skipping');
    }
  } catch (error: any) {
    logger.error('Migration 012 (MySQL) failed:', error.message);
    throw error;
  }

  logger.info('Migration 012 complete (MySQL): Auth schema aligned');
}
