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
