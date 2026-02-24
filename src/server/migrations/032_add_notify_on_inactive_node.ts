import type Database from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database.Database): void => {
    logger.debug('Running migration 032: Add notify_on_inactive_node and monitored_nodes to notification preferences...');

    // Add notify_on_inactive_node column with default value of 0 (false)
    db.exec(`
      ALTER TABLE user_notification_preferences
      ADD COLUMN notify_on_inactive_node BOOLEAN DEFAULT 0
    `);
    logger.debug('✅ Added notify_on_inactive_node column');

    // Add monitored_nodes column to store JSON array of node IDs
    db.exec(`
      ALTER TABLE user_notification_preferences
      ADD COLUMN monitored_nodes TEXT
    `);
    logger.debug('✅ Added monitored_nodes column');

    logger.debug('✅ Migration 032 completed successfully');
  },

  down: (db: Database.Database): void => {
    logger.debug('Reverting migration 032: Remove notify_on_inactive_node and monitored_nodes columns...');

    // SQLite doesn't support DROP COLUMN directly, so we need to recreate the table
    db.exec(`
      -- Create temporary table without new columns
      CREATE TABLE user_notification_preferences_temp (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        enable_web_push BOOLEAN DEFAULT 1,
        enable_apprise BOOLEAN DEFAULT 0,
        enabled_channels TEXT,
        enable_direct_messages BOOLEAN DEFAULT 1,
        notify_on_emoji BOOLEAN DEFAULT 1,
        notify_on_new_node BOOLEAN DEFAULT 1,
        notify_on_traceroute BOOLEAN DEFAULT 1,
        whitelist TEXT,
        blacklist TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(user_id)
      );

      -- Copy data from old table
      INSERT INTO user_notification_preferences_temp
      SELECT id, user_id, enable_web_push, enable_apprise, enabled_channels,
             enable_direct_messages, notify_on_emoji, notify_on_new_node, 
             notify_on_traceroute, whitelist, blacklist, created_at, updated_at
      FROM user_notification_preferences;

      -- Drop old table
      DROP TABLE user_notification_preferences;

      -- Rename temp table
      ALTER TABLE user_notification_preferences_temp RENAME TO user_notification_preferences;
    `);

    logger.debug('✅ Migration 032 reverted');
  }
};

