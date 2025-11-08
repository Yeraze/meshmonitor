/**
 * Migration 021: Add system_backup_history table
 *
 * Creates a new table to track full system database backups (separate from
 * device configuration backups). System backups include all database tables
 * exported to JSON format with metadata for version tracking and integrity.
 *
 * This enables disaster recovery, server migration, and database rollback
 * capabilities for the entire MeshMonitor system.
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database): void => {
    logger.debug('Running migration 021: Add system_backup_history table');

    try {
      // Create system_backup_history table to track full system backups
      db.exec(`
        CREATE TABLE IF NOT EXISTS system_backup_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          dirname TEXT NOT NULL UNIQUE,
          timestamp INTEGER NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('manual', 'automatic')),
          size INTEGER NOT NULL,
          table_count INTEGER NOT NULL,
          meshmonitor_version TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          createdAt INTEGER NOT NULL
        );
      `);
      logger.debug('✅ Created system_backup_history table');

      // Create index on timestamp for efficient querying
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_system_backup_history_timestamp
        ON system_backup_history(timestamp DESC);
      `);
      logger.debug('✅ Created index on system_backup_history.timestamp');

      // Create index on type for filtering
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_system_backup_history_type
        ON system_backup_history(type);
      `);
      logger.debug('✅ Created index on system_backup_history.type');

      logger.debug('✅ Migration 021 completed successfully');
      logger.debug('ℹ️  System backup settings are stored in the settings table with key prefix "system_backup_"');
    } catch (error: any) {
      if (error.message && error.message.includes('already exists')) {
        logger.debug('⏭️  system_backup_history table already exists, skipping');
      } else {
        logger.error('❌ Migration 021 failed:', error);
        throw error;
      }
    }
  },

  down: (db: Database): void => {
    logger.debug('Reverting migration 021: Remove system_backup_history table');

    try {
      db.exec('DROP TABLE IF EXISTS system_backup_history');
      logger.debug('✅ Migration 021 reverted');
    } catch (error) {
      logger.error('❌ Migration 021 rollback failed:', error);
      throw error;
    }
  }
};
