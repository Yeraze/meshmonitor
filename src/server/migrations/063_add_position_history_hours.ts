/**
 * Migration 063: Add position_history_hours column to user_map_preferences
 *
 * This column stores the user's preferred position history duration
 * for the position history slider (null = show all history).
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

/**
 * SQLite migration: Add position_history_hours column
 */
export const migration = {
  up: (db: Database): void => {
    logger.debug('Running migration 063: Adding position_history_hours column...');

    // Check if column already exists
    const tableInfo = db.prepare('PRAGMA table_info(user_map_preferences)').all() as Array<{ name: string }>;
    const columnExists = tableInfo.some((col) => col.name === 'position_history_hours');

    if (!columnExists) {
      db.prepare('ALTER TABLE user_map_preferences ADD COLUMN position_history_hours INTEGER DEFAULT NULL').run();
      logger.debug('✅ Added position_history_hours column to user_map_preferences');
    } else {
      logger.debug('Column position_history_hours already exists, skipping');
    }
  },

  down: (_db: Database): void => {
    logger.debug('Migration 063 down: SQLite does not support dropping columns');
    // SQLite doesn't support ALTER TABLE DROP COLUMN in older versions
  },
};

/**
 * PostgreSQL migration: Add position_history_hours column
 */
export async function runMigration063Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info('Running migration 063 (PostgreSQL): Adding position_history_hours column...');

  try {
    // Check if column exists
    const result = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'user_map_preferences' AND column_name = 'position_history_hours'
    `);

    if (result.rows.length === 0) {
      await client.query(`
        ALTER TABLE user_map_preferences
        ADD COLUMN position_history_hours INTEGER DEFAULT NULL
      `);
      logger.debug('✅ Added position_history_hours column to user_map_preferences');
    } else {
      logger.debug('Column position_history_hours already exists, skipping');
    }
  } catch (error: any) {
    logger.error('Failed to add position_history_hours column:', error.message);
    throw error;
  }

  logger.info('✅ Migration 063 complete (PostgreSQL)');
}

/**
 * MySQL migration: Add position_history_hours column
 */
export async function runMigration063Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info('Running migration 063 (MySQL): Adding position_history_hours column...');

  try {
    // Check if column exists
    const [rows] = await pool.query(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = 'user_map_preferences' AND COLUMN_NAME = 'position_history_hours'
    `);

    if ((rows as any[]).length === 0) {
      await pool.query(`
        ALTER TABLE user_map_preferences
        ADD COLUMN position_history_hours INT DEFAULT NULL
      `);
      logger.debug('✅ Added position_history_hours column to user_map_preferences');
    } else {
      logger.debug('Column position_history_hours already exists, skipping');
    }
  } catch (error: any) {
    logger.error('Failed to add position_history_hours column:', error.message);
    throw error;
  }

  logger.info('✅ Migration 063 complete (MySQL)');
}
