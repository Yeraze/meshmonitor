/**
 * Migration 031: Add sorting preferences to user_map_preferences table
 *
 * Adds columns for preferred sort field and direction to allow
 * per-user node list sorting preferences.
 */

import Database from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database.Database): void => {
    logger.info('Running migration 031: Add sorting preferences to user_map_preferences');

    try {
      // Add preferred_sort_field and preferred_sort_direction columns
      db.exec(`
        ALTER TABLE user_map_preferences
        ADD COLUMN preferred_sort_field TEXT DEFAULT 'longName'
      `);

      db.exec(`
        ALTER TABLE user_map_preferences
        ADD COLUMN preferred_sort_direction TEXT DEFAULT 'asc'
      `);

      // Add CHECK constraints for the new columns
      // Note: SQLite doesn't support adding CHECK constraints via ALTER TABLE,
      // so we'll validate in application code instead

      logger.info('✅ Migration 031 completed: sorting preferences added to user_map_preferences');
    } catch (error) {
      logger.error('❌ Migration 031 failed:', error);
      throw error;
    }
  },

  down: (_db: Database.Database): void => {
    logger.info('Reverting migration 031: Remove sorting preferences from user_map_preferences');

    try {
      // SQLite doesn't support DROP COLUMN directly, would need to recreate table
      // For now, leaving columns in place on rollback
      logger.warn('⚠️ Migration 031 rollback: SQLite does not support DROP COLUMN, columns will remain');
      logger.info('✅ Migration 031 reverted (columns remain but will be ignored)');
    } catch (error) {
      logger.error('❌ Migration 031 revert failed:', error);
      throw error;
    }
  }
};
