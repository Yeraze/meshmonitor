import Database from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database.Database): void => {
    logger.debug('Running migration 042: Add relay_node field to packet_log table...');

    // Add relay_node column to packet_log table to store which node relayed the packet
    db.exec(`
      ALTER TABLE packet_log ADD COLUMN relay_node INTEGER;
    `);

    logger.debug('✅ Added relay_node field to packet_log table');
  },

  down: (_db: Database.Database): void => {
    logger.debug('Rolling back migration 042: Remove relay_node field from packet_log table...');

    // SQLite doesn't support DROP COLUMN easily, so we'd need to recreate the table
    // For now, just log a warning
    logger.warn('⚠️ Cannot easily roll back column additions in SQLite. Field will remain but be unused.');
  }
};
