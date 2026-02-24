/**
 * Migration 017: Add channel column to nodes table
 *
 * Adds the channel field to the nodes table to track which channel
 * a node was heard on (from NodeInfo packets).
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database): void => {
    logger.debug('Running migration 017: Add channel column to nodes table');

    try {
      // Check if the column already exists
      const columns = db.pragma("table_info('nodes')") as Array<{ name: string }>;
      const hasChannelColumn = columns.some((col) => col.name === 'channel');

      if (!hasChannelColumn) {
        // Add the channel column to the nodes table
        db.exec(`
          ALTER TABLE nodes ADD COLUMN channel INTEGER;
        `);
        logger.debug('✅ Added channel column to nodes table');
      } else {
        logger.debug('✅ Channel column already exists, skipping');
      }

      logger.debug('✅ Migration 017 completed: channel column added to nodes table');
    } catch (error) {
      logger.error('❌ Migration 017 failed:', error);
      throw error;
    }
  },

  down: (_db: Database): void => {
    logger.debug('Running migration 017 down: Remove channel column from nodes table');

    try {
      // SQLite doesn't support DROP COLUMN directly until version 3.35.0
      // For older versions, we'd need to recreate the table without the column
      // But for this case, we'll just note that the column can remain
      logger.debug('⚠️  Note: SQLite DROP COLUMN requires version 3.35.0+');
      logger.debug('⚠️  The channel column will remain but will not be used');

      // For SQLite 3.35.0+, uncomment the following:
      // db.exec(`ALTER TABLE nodes DROP COLUMN channel;`);

      logger.debug('✅ Migration 017 rollback completed');
    } catch (error) {
      logger.error('❌ Migration 017 rollback failed:', error);
      throw error;
    }
  }
};
