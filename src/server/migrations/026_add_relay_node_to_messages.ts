import Database from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database.Database): void => {
    logger.debug('Running migration 026: Add relayNode field to messages table...');

    // Add relayNode column to messages table to store which node relayed the message
    db.exec(`
      ALTER TABLE messages ADD COLUMN relayNode INTEGER;
    `);

    logger.debug('✅ Added relayNode field to messages table');
  },

  down: (_db: Database.Database): void => {
    logger.debug('Rolling back migration 026: Remove relayNode field from messages table...');

    // SQLite doesn't support DROP COLUMN easily, so we'd need to recreate the table
    // For now, just log a warning
    logger.warn('⚠️ Cannot easily roll back column additions in SQLite. Field will remain but be unused.');
  }
};
