/**
 * Migration 018: Add mobile column to nodes table
 *
 * Adds the mobile field to the nodes table to track whether a node
 * is mobile (has moved more than 100 meters). This is pre-computed
 * during packet processing to avoid expensive queries on every poll.
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database): void => {
    logger.debug('Running migration 018: Add mobile column to nodes table');

    try {
      // Check if the column already exists
      const columns = db.pragma("table_info('nodes')") as Array<{ name: string }>;
      const hasMobileColumn = columns.some((col) => col.name === 'mobile');

      if (!hasMobileColumn) {
        // Add the mobile column to the nodes table
        db.exec(`
          ALTER TABLE nodes ADD COLUMN mobile INTEGER DEFAULT 0;
        `);
        logger.debug('✅ Added mobile column to nodes table');

        // Create index for efficient filtering of mobile nodes
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_nodes_mobile ON nodes(mobile);
        `);
        logger.debug('✅ Created index on mobile column');
      } else {
        logger.debug('✅ Mobile column already exists, skipping');
      }

      logger.debug('✅ Migration 018 completed: mobile column added to nodes table');
    } catch (error) {
      logger.error('❌ Migration 018 failed:', error);
      throw error;
    }
  },

  down: (_db: Database): void => {
    logger.debug('Running migration 018 down: Remove mobile column from nodes table');

    try {
      // SQLite doesn't support DROP COLUMN directly until version 3.35.0
      // For older versions, we'd need to recreate the table without the column
      // But for this case, we'll just note that the column can remain
      logger.debug('⚠️  Note: SQLite DROP COLUMN requires version 3.35.0+');
      logger.debug('⚠️  The mobile column will remain but will not be used');

      // For SQLite 3.35.0+, uncomment the following:
      // db.exec(`DROP INDEX IF EXISTS idx_nodes_mobile;`);
      // db.exec(`ALTER TABLE nodes DROP COLUMN mobile;`);

      logger.debug('✅ Migration 018 rollback completed');
    } catch (error) {
      logger.error('❌ Migration 018 rollback failed:', error);
      throw error;
    }
  }
};
