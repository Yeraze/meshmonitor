import type Database from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database.Database): void => {
    logger.debug('Running migration 013: Add backup_history table...');

    // Create backup_history table to track all backups
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS backup_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          filename TEXT NOT NULL UNIQUE,
          filepath TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('manual', 'automatic')),
          size INTEGER NOT NULL,
          createdAt INTEGER NOT NULL,
          UNIQUE(filename)
        );
      `);
      logger.debug('✅ Created backup_history table');
    } catch (error: any) {
      if (error.message && error.message.includes('already exists')) {
        logger.debug('⏭️  backup_history table already exists, skipping');
      } else {
        throw error;
      }
    }

    // Create index on timestamp for efficient querying
    try {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_backup_history_timestamp
        ON backup_history(timestamp DESC);
      `);
      logger.debug('✅ Created index on backup_history.timestamp');
    } catch (error: any) {
      logger.debug('⏭️  Index already exists or error creating it:', error);
    }

    // Create index on type for filtering
    try {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_backup_history_type
        ON backup_history(type);
      `);
      logger.debug('✅ Created index on backup_history.type');
    } catch (error: any) {
      logger.debug('⏭️  Index already exists or error creating it:', error);
    }

    logger.debug('✅ Migration 013 completed successfully');
    logger.debug('ℹ️  Note: Backup settings are stored in the settings table with key prefix "backup_"');
  },

  down: (db: Database.Database): void => {
    logger.debug('Reverting migration 013: Remove backup_history table...');

    db.exec('DROP TABLE IF EXISTS backup_history');

    logger.debug('✅ Migration 013 reverted');
  }
};
