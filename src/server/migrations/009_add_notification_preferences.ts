import type Database from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database.Database): void => {
    logger.debug('Running migration 009: Add notification preferences table...');

    // Create user_notification_preferences table
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_notification_preferences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        enable_web_push BOOLEAN DEFAULT 1,
        enable_apprise BOOLEAN DEFAULT 0,
        enabled_channels TEXT,
        enable_direct_messages BOOLEAN DEFAULT 1,
        whitelist TEXT,
        blacklist TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(user_id)
      )
    `);

    logger.debug('✅ Created user_notification_preferences table');

    // Migrate existing push preferences from settings table to new table
    logger.debug('🔄 Migrating existing push preferences to new table...');

    // Get all users
    const usersStmt = db.prepare('SELECT id FROM users');
    const users = usersStmt.all() as Array<{ id: number }>;

    // Get all existing push preferences from settings
    const settingsStmt = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'push_prefs_%'");
    const settings = settingsStmt.all() as Array<{ key: string; value: string }>;

    const now = Date.now();

    for (const user of users) {
      // Check if this user has existing push preferences
      const prefKey = `push_prefs_${user.id}`;
      const existingPref = settings.find(s => s.key === prefKey);

      if (existingPref) {
        try {
          // Parse existing preferences
          const prefs = JSON.parse(existingPref.value);

          // Insert into new table with web push enabled (preserving existing behavior)
          const insertStmt = db.prepare(`
            INSERT OR IGNORE INTO user_notification_preferences (
              user_id, enable_web_push, enable_apprise,
              enabled_channels, enable_direct_messages,
              whitelist, blacklist,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);

          insertStmt.run(
            user.id,
            1, // enable_web_push = true (existing users had it enabled)
            0, // enable_apprise = false (new feature, opt-in)
            JSON.stringify(prefs.enabledChannels || []),
            prefs.enableDirectMessages !== undefined ? (prefs.enableDirectMessages ? 1 : 0) : 1,
            JSON.stringify(prefs.whitelist || []),
            JSON.stringify(prefs.blacklist || []),
            now,
            now
          );

          logger.debug(`   Migrated preferences for user ${user.id}`);
        } catch (error) {
          logger.error(`   Failed to migrate preferences for user ${user.id}:`, error);
        }
      } else {
        // User has no existing preferences, create default entry
        const insertStmt = db.prepare(`
          INSERT OR IGNORE INTO user_notification_preferences (
            user_id, enable_web_push, enable_apprise,
            enabled_channels, enable_direct_messages,
            whitelist, blacklist,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        insertStmt.run(
          user.id,
          1, // enable_web_push = true by default
          0, // enable_apprise = false (new feature, opt-in)
          JSON.stringify([]), // empty enabled channels
          1, // enable DMs by default
          JSON.stringify([]), // empty whitelist
          JSON.stringify([]), // empty blacklist
          now,
          now
        );
      }
    }

    logger.debug('✅ Migration 009 completed successfully');
  },

  down: (db: Database.Database): void => {
    logger.debug('Reverting migration 009: Remove notification preferences table...');
    db.exec('DROP TABLE IF EXISTS user_notification_preferences');
    logger.debug('✅ Migration 009 reverted');
  }
};
