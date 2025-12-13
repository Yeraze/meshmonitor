/**
 * Migration: Add notify_on_mqtt column to user_notification_preferences
 *
 * This allows users to filter notifications for messages received via MQTT bridge.
 * When disabled, messages that came over MQTT will not trigger notifications.
 */
import Database from 'better-sqlite3';

export const migration = {
  up: (db: Database.Database): void => {
    // Add notify_on_mqtt column with default true (current behavior - notify on all messages)
    db.exec(`ALTER TABLE user_notification_preferences ADD COLUMN notify_on_mqtt BOOLEAN DEFAULT 1`);
  },

  down: (db: Database.Database): void => {
    // SQLite doesn't support DROP COLUMN directly, need to recreate table
    db.exec(`
      CREATE TABLE user_notification_preferences_backup AS SELECT
        user_id, enable_web_push, enable_apprise, enabled_channels, enable_direct_messages,
        notify_on_emoji, notify_on_new_node, notify_on_traceroute, notify_on_inactive_node,
        notify_on_server_events, prefix_with_node_name, monitored_nodes, whitelist, blacklist,
        apprise_urls, created_at, updated_at
      FROM user_notification_preferences;

      DROP TABLE user_notification_preferences;

      CREATE TABLE user_notification_preferences (
        user_id INTEGER PRIMARY KEY,
        enable_web_push BOOLEAN DEFAULT 1,
        enable_apprise BOOLEAN DEFAULT 0,
        enabled_channels TEXT DEFAULT '[]',
        enable_direct_messages BOOLEAN DEFAULT 1,
        notify_on_emoji BOOLEAN DEFAULT 1,
        notify_on_new_node BOOLEAN DEFAULT 1,
        notify_on_traceroute BOOLEAN DEFAULT 1,
        notify_on_inactive_node BOOLEAN DEFAULT 0,
        notify_on_server_events BOOLEAN DEFAULT 0,
        prefix_with_node_name BOOLEAN DEFAULT 0,
        monitored_nodes TEXT DEFAULT '[]',
        whitelist TEXT DEFAULT '[]',
        blacklist TEXT DEFAULT '[]',
        apprise_urls TEXT DEFAULT '[]',
        created_at INTEGER,
        updated_at INTEGER,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      INSERT INTO user_notification_preferences SELECT * FROM user_notification_preferences_backup;
      DROP TABLE user_notification_preferences_backup;
    `);
  }
};
