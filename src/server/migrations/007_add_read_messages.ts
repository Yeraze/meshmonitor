import Database from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database.Database): void => {
    logger.debug('Running migration 007: Add read_messages table...');

    // Create read_messages table to track which messages have been read
    db.exec(`
      CREATE TABLE IF NOT EXISTS read_messages (
        message_id TEXT NOT NULL,
        user_id INTEGER,
        read_at INTEGER NOT NULL,
        PRIMARY KEY (message_id, user_id),
        FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    // Create index for efficient queries
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_read_messages_user ON read_messages(user_id);
      CREATE INDEX IF NOT EXISTS idx_read_messages_message ON read_messages(message_id);
      CREATE INDEX IF NOT EXISTS idx_read_messages_read_at ON read_messages(read_at);
    `);

    logger.debug('✅ Created read_messages table and indexes');
  },

  down: (db: Database.Database): void => {
    logger.debug('Rolling back migration 007: Remove read_messages table...');
    db.exec('DROP TABLE IF NOT EXISTS read_messages');
    logger.debug('✅ Removed read_messages table');
  }
};
