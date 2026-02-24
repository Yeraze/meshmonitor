import Database from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database.Database): void => {
    logger.debug('Running migration 008: Add push_subscriptions table...');

    // Create push_subscriptions table to store Web Push subscription data
    db.exec(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh_key TEXT NOT NULL,
        auth_key TEXT NOT NULL,
        user_agent TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_used_at INTEGER,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    // Create indexes for efficient queries
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);
      CREATE INDEX IF NOT EXISTS idx_push_subscriptions_endpoint ON push_subscriptions(endpoint);
      CREATE INDEX IF NOT EXISTS idx_push_subscriptions_last_used ON push_subscriptions(last_used_at);
    `);

    logger.debug('✅ Created push_subscriptions table and indexes');
  },

  down: (db: Database.Database): void => {
    logger.debug('Rolling back migration 008: Remove push_subscriptions table...');
    db.exec('DROP TABLE IF EXISTS push_subscriptions');
    logger.debug('✅ Removed push_subscriptions table');
  }
};
