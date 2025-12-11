/**
 * Migration 033: Add isIgnored column to nodes table
 *
 * Adds the isIgnored field to the nodes table to track whether a node
 * is in the ignored list on the device. This allows the UI to display
 * and manage ignored nodes similar to favorites.
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database): void => {
    logger.debug('Running migration 033: Add isIgnored column to nodes table');

    try {
      // Check if the column already exists
      const columns = db.pragma("table_info('nodes')") as Array<{ name: string }>;
      const hasIgnoredColumn = columns.some((col) => col.name === 'isIgnored');

      if (!hasIgnoredColumn) {
        // Add the isIgnored column to the nodes table
        db.exec(`
          ALTER TABLE nodes ADD COLUMN isIgnored BOOLEAN DEFAULT 0;
        `);
        logger.debug('✅ Added isIgnored column to nodes table');

        // Create index for efficient filtering of ignored nodes
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_nodes_is_ignored ON nodes(isIgnored);
        `);
        logger.debug('✅ Created index on isIgnored column');
      } else {
        logger.debug('✅ isIgnored column already exists, skipping');
      }

      logger.debug('✅ Migration 033 completed: isIgnored column added to nodes table');
    } catch (error) {
      logger.error('❌ Migration 033 failed:', error);
      throw error;
    }
  },

  down: (_db: Database): void => {
    logger.debug('Running migration 033 down: Remove isIgnored column from nodes table');

    try {
      // SQLite doesn't support DROP COLUMN directly until version 3.35.0
      // For older versions, we'd need to recreate the table without the column
      // But for this case, we'll just note that the column can remain
      logger.debug('⚠️  Note: SQLite DROP COLUMN requires version 3.35.0+');
      logger.debug('⚠️  The isIgnored column will remain but will not be used');

      // For SQLite 3.35.0+, uncomment the following:
      // db.exec(`DROP INDEX IF EXISTS idx_nodes_is_ignored;`);
      // db.exec(`ALTER TABLE nodes DROP COLUMN isIgnored;`);

      logger.debug('✅ Migration 033 rollback completed');
    } catch (error) {
      logger.error('❌ Migration 033 rollback failed:', error);
      throw error;
    }
  }
};

