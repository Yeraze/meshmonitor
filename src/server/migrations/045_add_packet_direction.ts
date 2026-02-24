import Database from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database.Database): void => {
    logger.debug('Running migration 045: Add direction field to packet_log table...');

    // Add direction column to packet_log table
    // 'rx' = received (incoming), 'tx' = transmitted (outgoing)
    // Default to 'rx' for existing packets
    db.exec(`
      ALTER TABLE packet_log ADD COLUMN direction TEXT DEFAULT 'rx';
    `);

    logger.debug('✅ Added direction field to packet_log table');
  },

  down: (_db: Database.Database): void => {
    logger.debug('Rolling back migration 045: Remove direction field from packet_log table...');

    // SQLite doesn't support DROP COLUMN easily, so we'd need to recreate the table
    // For now, just log a warning
    logger.warn('⚠️ Cannot easily roll back column additions in SQLite. Field will remain but be unused.');
  }
};
