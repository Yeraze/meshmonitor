/**
 * Migration 042: Add position privacy to nodes table
 *
 * Adds column to allow users to make their position override private.
 * When enabled, the override is only visible to logged-in users.
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database): void => {
    logger.debug('Running migration 042: Add position privacy to nodes table');

    try {
      // Check which columns already exist
      const columns = db.pragma("table_info('nodes')") as Array<{ name: string }>;
      const columnNames = new Set(columns.map((col) => col.name));

      // Add positionOverrideIsPrivate column
      if (!columnNames.has('positionOverrideIsPrivate')) {
        db.exec(`
          ALTER TABLE nodes ADD COLUMN positionOverrideIsPrivate INTEGER DEFAULT 0;
        `);
        logger.debug('✅ Added positionOverrideIsPrivate column to nodes table');
      } else {
        logger.debug('✅ positionOverrideIsPrivate column already exists, skipping');
      }

      logger.debug('✅ Migration 042 completed: position privacy column added to nodes table');
    } catch (error) {
      logger.error('❌ Migration 042 failed:', error);
      throw error;
    }
  },

  down: (_db: Database): void => {
    logger.debug('Running migration 042 down: Remove position privacy column from nodes table');

    try {
      logger.debug('⚠️  Note: SQLite DROP COLUMN requires version 3.35.0+');
      logger.debug('⚠️  The position privacy column will remain but will not be used');

      // For SQLite 3.35.0+, uncomment the following:
      // db.exec(`ALTER TABLE nodes DROP COLUMN positionOverrideIsPrivate;`);

      logger.debug('✅ Migration 042 rollback completed');
    } catch (error) {
      logger.error('❌ Migration 042 rollback failed:', error);
      throw error;
    }
  }
};
