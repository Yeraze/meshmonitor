/**
 * Migration 005: Enhance audit log table
 *
 * Adds indexes for better query performance and optional before/after columns
 * for tracking state changes (especially for settings)
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database): void => {
    logger.debug('Running migration 005: Enhance audit log table');

    try {
      // 1. Add before/after columns for tracking state changes
      db.exec(`
        ALTER TABLE audit_log ADD COLUMN value_before TEXT;
      `);
      logger.debug('✅ Added value_before column');

      db.exec(`
        ALTER TABLE audit_log ADD COLUMN value_after TEXT;
      `);
      logger.debug('✅ Added value_after column');

      // 2. Create indexes for better query performance
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp DESC);
      `);
      logger.debug('✅ Created index on timestamp');

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id);
      `);
      logger.debug('✅ Created index on user_id');

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
      `);
      logger.debug('✅ Created index on action');

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_audit_log_resource ON audit_log(resource);
      `);
      logger.debug('✅ Created index on resource');

      logger.debug('✅ Migration 005 completed: Audit log enhanced');
    } catch (error: any) {
      // Check if columns already exist
      if (error.message?.includes('duplicate column')) {
        logger.debug('⚠️ Audit log columns already exist, skipping column additions');
      } else {
        logger.error('❌ Migration 005 failed:', error);
        throw error;
      }
    }
  },

  down: (db: Database): void => {
    logger.debug('Running migration 005 down: Remove audit log enhancements');

    try {
      // SQLite doesn't support DROP COLUMN directly
      // We need to recreate the table without the new columns

      // 1. Create new table without value_before/value_after
      db.exec(`
        CREATE TABLE audit_log_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER,
          action TEXT NOT NULL,
          resource TEXT,
          details TEXT,
          ip_address TEXT,
          timestamp INTEGER NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id)
        )
      `);

      // 2. Copy data (excluding new columns)
      db.exec(`
        INSERT INTO audit_log_new (id, user_id, action, resource, details, ip_address, timestamp)
        SELECT id, user_id, action, resource, details, ip_address, timestamp
        FROM audit_log
      `);

      // 3. Drop old table
      db.exec(`DROP TABLE audit_log`);

      // 4. Rename new table
      db.exec(`ALTER TABLE audit_log_new RENAME TO audit_log`);

      logger.debug('✅ Migration 005 rollback completed');
    } catch (error) {
      logger.error('❌ Migration 005 rollback failed:', error);
      throw error;
    }
  }
};
