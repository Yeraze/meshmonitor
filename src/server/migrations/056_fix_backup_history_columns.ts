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
      // Check if we need to migrate (if old column names exist)
      const tableInfo = db.prepare("PRAGMA table_info(backup_history)").all() as any[];
      const hasOldColumns = tableInfo.some((col: any) => col.name === 'filepath' || col.name === 'type' || col.name === 'size');
      const hasNewColumns = tableInfo.some((col: any) => col.name === 'filePath' || col.name === 'backupType' || col.name === 'fileSize');

      if (hasNewColumns && !hasOldColumns) {
        logger.debug('backup_history already has new column names, skipping migration');
        return;
      }

      if (!hasOldColumns && !hasNewColumns) {
        logger.debug('backup_history table does not exist or has unexpected schema, skipping migration');
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
