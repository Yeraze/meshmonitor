/**
 * Migration 030: Add user_map_preferences table
 *
 * Adds a table to store per-user map preferences including:
 * - Map tileset selection
 * - Map filter settings (showPaths, showNeighborInfo, showRoute, etc.)
 *
 * These preferences persist across logins and allow each user to have
 * their own map view configuration.
 */

import Database from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database.Database): void => {
  logger.info('Running migration 030: Add user_map_preferences table');

  try {
    // Create user_map_preferences table
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_map_preferences (
        user_id INTEGER PRIMARY KEY,
        map_tileset TEXT,
        show_paths INTEGER DEFAULT 0,
        show_neighbor_info INTEGER DEFAULT 0,
        show_route INTEGER DEFAULT 1,
        show_motion INTEGER DEFAULT 1,
        show_mqtt_nodes INTEGER DEFAULT 1,
        show_animations INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        CHECK (show_paths IN (0, 1)),
        CHECK (show_neighbor_info IN (0, 1)),
        CHECK (show_route IN (0, 1)),
        CHECK (show_motion IN (0, 1)),
        CHECK (show_mqtt_nodes IN (0, 1)),
        CHECK (show_animations IN (0, 1))
      )
    `);

    // Create index for faster lookups
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_user_map_preferences_user_id
      ON user_map_preferences(user_id)
    `);

    logger.info('✅ Migration 030 completed: user_map_preferences table created');
  } catch (error) {
    logger.error('❌ Migration 030 failed:', error);
    throw error;
  }
  },

  down: (db: Database.Database): void => {
  logger.info('Reverting migration 030: Remove user_map_preferences table');

  try {
    // Drop index
    db.exec(`DROP INDEX IF EXISTS idx_user_map_preferences_user_id`);

    // Drop table
    db.exec(`DROP TABLE IF EXISTS user_map_preferences`);

    logger.info('✅ Migration 030 reverted: user_map_preferences table removed');
  } catch (error) {
    logger.error('❌ Migration 030 revert failed:', error);
    throw error;
  }
  }
};
