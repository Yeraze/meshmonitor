import Database from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database.Database): void => {
    logger.debug('Running migration 014: Add message delivery tracking fields...');

    // Add delivery tracking columns to messages table
    db.exec(`
      ALTER TABLE messages ADD COLUMN requestId INTEGER;
    `);

    db.exec(`
      ALTER TABLE messages ADD COLUMN ackFailed BOOLEAN DEFAULT 0;
    `);

    db.exec(`
      ALTER TABLE messages ADD COLUMN routingErrorReceived BOOLEAN DEFAULT 0;
    `);

    db.exec(`
      ALTER TABLE messages ADD COLUMN deliveryState TEXT;
    `);

    db.exec(`
      ALTER TABLE messages ADD COLUMN wantAck BOOLEAN DEFAULT 0;
    `);

    // Create index for efficient requestId lookups
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_requestId ON messages(requestId);
    `);

    logger.debug('✅ Added message delivery tracking fields and indexes');
  },

  down: (_db: Database.Database): void => {
    logger.debug('Rolling back migration 014: Remove message delivery tracking fields...');

    // SQLite doesn't support DROP COLUMN easily, so we'd need to recreate the table
    // For now, just log a warning
    logger.warn('⚠️ Cannot easily roll back column additions in SQLite. Fields will remain but be unused.');
  }
};
