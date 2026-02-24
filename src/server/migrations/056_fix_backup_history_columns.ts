/**
 * Migration 056: Fix backup_history column names
 *
 * The original migration 013 created backup_history with column names:
 * - filepath (lowercase)
 * - type
 * - size
 *
 * But the current backupFileService.ts expects:
 * - filePath (camelCase)
 * - backupType
 * - fileSize
 *
 * This migration renames the columns to match the service expectations.
 * SQLite requires recreating the table to rename columns.
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database): void => {
    logger.debug('Running migration 056: Fix backup_history column names');

    try {
      // Check if table exists at all
      const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='backup_history'").get();
      if (!tableExists) {
        logger.debug('backup_history table does not exist, creating with new schema');
        db.exec(`
          CREATE TABLE backup_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nodeId TEXT,
            nodeNum INTEGER,
            filename TEXT NOT NULL,
            filePath TEXT NOT NULL,
            fileSize INTEGER,
            backupType TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            createdAt INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_backup_history_timestamp ON backup_history(timestamp DESC);
        `);
        return;
      }

      // Check current column names
      const tableInfo = db.prepare("PRAGMA table_info(backup_history)").all() as any[];
      const columnNames = tableInfo.map((col: any) => col.name);

      // Check for old-style columns (lowercase)
      const hasOldFilepath = columnNames.includes('filepath');
      const hasOldType = columnNames.includes('type');
      const hasOldSize = columnNames.includes('size');
      const hasOldColumns = hasOldFilepath || hasOldType || hasOldSize;

      // Check for new-style columns (camelCase)
      const hasNewFilePath = columnNames.includes('filePath');
      const hasNewBackupType = columnNames.includes('backupType');
      const hasNewFileSize = columnNames.includes('fileSize');
      const hasNewColumns = hasNewFilePath || hasNewBackupType || hasNewFileSize;

      // Check for timestamp column (required in both old and new schema)
      const hasTimestamp = columnNames.includes('timestamp');
      const hasCreatedAt = columnNames.includes('createdAt');

      logger.debug(`backup_history columns: ${columnNames.join(', ')}`);
      logger.debug(`hasOldColumns: ${hasOldColumns}, hasNewColumns: ${hasNewColumns}, hasTimestamp: ${hasTimestamp}`);

      if (hasNewColumns && !hasOldColumns) {
        logger.debug('backup_history already has new column names, skipping migration');
        return;
      }

      if (!hasOldColumns && !hasNewColumns) {
        // Table exists but has unexpected schema - recreate it
        logger.debug('backup_history has unexpected schema, recreating table');
        db.exec(`
          DROP TABLE IF EXISTS backup_history;
          CREATE TABLE backup_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nodeId TEXT,
            nodeNum INTEGER,
            filename TEXT NOT NULL,
            filePath TEXT NOT NULL,
            fileSize INTEGER,
            backupType TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            createdAt INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_backup_history_timestamp ON backup_history(timestamp DESC);
        `);
        return;
      }

      // We have old columns - migrate to new schema
      // First, check what columns actually exist for the SELECT statement
      if (!hasTimestamp || !hasCreatedAt) {
        // Missing required columns - drop and recreate
        logger.debug('backup_history missing required columns (timestamp/createdAt), recreating table');
        db.exec(`
          DROP TABLE IF EXISTS backup_history;
          CREATE TABLE backup_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nodeId TEXT,
            nodeNum INTEGER,
            filename TEXT NOT NULL,
            filePath TEXT NOT NULL,
            fileSize INTEGER,
            backupType TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            createdAt INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_backup_history_timestamp ON backup_history(timestamp DESC);
        `);
        return;
      }

      // SQLite doesn't support RENAME COLUMN in older versions, so we need to recreate the table
      db.exec(`
        -- Create new table with correct column names
        CREATE TABLE IF NOT EXISTS backup_history_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          nodeId TEXT,
          nodeNum INTEGER,
          filename TEXT NOT NULL,
          filePath TEXT NOT NULL,
          fileSize INTEGER,
          backupType TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          createdAt INTEGER NOT NULL
        );

        -- Copy data from old table to new table
        INSERT INTO backup_history_new (id, filename, filePath, fileSize, backupType, timestamp, createdAt)
        SELECT id, filename, filepath, size, type, timestamp, createdAt
        FROM backup_history;

        -- Drop old table
        DROP TABLE backup_history;

        -- Rename new table to original name
        ALTER TABLE backup_history_new RENAME TO backup_history;

        -- Recreate indexes
        CREATE INDEX IF NOT EXISTS idx_backup_history_timestamp ON backup_history(timestamp DESC);
      `);

      logger.debug('Successfully migrated backup_history columns');
    } catch (error: any) {
      if (error.message && error.message.includes('no such table')) {
        logger.debug('backup_history table does not exist, skipping migration');
      } else {
        logger.error('Migration 056 failed:', error);
        throw error;
      }
    }
  },

  down: (db: Database): void => {
    logger.debug('Reverting migration 056: Restore old backup_history column names');

    try {
      db.exec(`
        -- Create table with old column names
        CREATE TABLE IF NOT EXISTS backup_history_old (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          filename TEXT NOT NULL UNIQUE,
          filepath TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('manual', 'automatic')),
          size INTEGER NOT NULL,
          createdAt INTEGER NOT NULL
        );

        -- Copy data back
        INSERT INTO backup_history_old (id, filename, filepath, timestamp, type, size, createdAt)
        SELECT id, filename, filePath, timestamp, backupType, fileSize, createdAt
        FROM backup_history;

        -- Drop new table
        DROP TABLE backup_history;

        -- Rename to original name
        ALTER TABLE backup_history_old RENAME TO backup_history;

        -- Recreate indexes
        CREATE INDEX IF NOT EXISTS idx_backup_history_timestamp ON backup_history(timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_backup_history_type ON backup_history(type);
      `);

      logger.debug('Successfully reverted backup_history columns');
    } catch (error) {
      logger.error('Migration 056 rollback failed:', error);
      throw error;
    }
  }
};

/**
 * PostgreSQL migration: Fix backup_history table schema
 * Must run BEFORE the main schema SQL to avoid index creation failures
 */
export async function runMigration056Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.debug('Running migration 056 (PostgreSQL): Fix backup_history schema');

  try {
    // Check if table exists
    const tableExists = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'backup_history'
      )
    `);

    if (!tableExists.rows[0].exists) {
      logger.debug('backup_history table does not exist, will be created by schema');
      return;
    }

    // Check if timestamp column exists
    const hasTimestamp = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'backup_history'
          AND column_name = 'timestamp'
      )
    `);

    if (hasTimestamp.rows[0].exists) {
      // Check if we have the new column names (filePath instead of filepath)
      const hasNewFilePath = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'backup_history'
            AND column_name = 'filePath'
        )
      `);

      if (hasNewFilePath.rows[0].exists) {
        logger.debug('backup_history schema is already correct, skipping');
        return;
      }
    }

    // Table exists but has wrong schema - drop and let the main schema SQL recreate it
    logger.debug('Recreating backup_history table with correct schema...');
    await client.query('DROP TABLE IF EXISTS backup_history CASCADE');

    // Create with correct schema
    await client.query(`
      CREATE TABLE backup_history (
        id SERIAL PRIMARY KEY,
        "nodeId" TEXT,
        "nodeNum" BIGINT,
        filename TEXT NOT NULL,
        "filePath" TEXT NOT NULL,
        "fileSize" BIGINT,
        "backupType" TEXT NOT NULL,
        timestamp BIGINT NOT NULL,
        "createdAt" BIGINT NOT NULL
      )
    `);

    // Create index
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_backup_history_timestamp ON backup_history(timestamp DESC)
    `);

    logger.debug('✅ Migration 056 (PostgreSQL): backup_history table recreated with correct schema');
  } catch (error) {
    logger.error('Migration 056 (PostgreSQL) failed:', error);
    throw error;
  }
}

/**
 * MySQL migration: Fix backup_history table schema
 * Must run BEFORE the main schema SQL to avoid index creation failures
 */
export async function runMigration056Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.debug('Running migration 056 (MySQL): Fix backup_history schema');

  try {
    const connection = await pool.getConnection();
    try {
      // Check if table exists
      const [tables] = await connection.query(`
        SELECT TABLE_NAME FROM information_schema.tables
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'backup_history'
      `);

      if ((tables as any[]).length === 0) {
        logger.debug('backup_history table does not exist, will be created by schema');
        return;
      }

      // Check if timestamp column exists
      const [timestampCol] = await connection.query(`
        SELECT COLUMN_NAME FROM information_schema.columns
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'backup_history'
          AND COLUMN_NAME = 'timestamp'
      `);

      if ((timestampCol as any[]).length > 0) {
        // Check if we have the new column names
        const [filePathCol] = await connection.query(`
          SELECT COLUMN_NAME FROM information_schema.columns
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'backup_history'
            AND COLUMN_NAME = 'filePath'
        `);

        if ((filePathCol as any[]).length > 0) {
          logger.debug('backup_history schema is already correct, skipping');
          return;
        }
      }

      // Table exists but has wrong schema - drop and recreate
      logger.debug('Recreating backup_history table with correct schema...');
      await connection.query('DROP TABLE IF EXISTS backup_history');

      // Create with correct schema
      await connection.query(`
        CREATE TABLE backup_history (
          id INT AUTO_INCREMENT PRIMARY KEY,
          nodeId VARCHAR(32),
          nodeNum BIGINT,
          filename VARCHAR(255) NOT NULL,
          filePath VARCHAR(512) NOT NULL,
          fileSize BIGINT,
          backupType VARCHAR(32) NOT NULL,
          timestamp BIGINT NOT NULL,
          createdAt BIGINT NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      // Create index
      await connection.query(`
        CREATE INDEX idx_backup_history_timestamp ON backup_history(timestamp DESC)
      `);

      logger.debug('✅ Migration 056 (MySQL): backup_history table recreated with correct schema');
    } finally {
      connection.release();
    }
  } catch (error) {
    logger.error('Migration 056 (MySQL) failed:', error);
    throw error;
  }
}
