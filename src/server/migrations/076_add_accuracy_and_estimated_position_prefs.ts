/**
 * Migration 076: Add show_accuracy_regions and show_estimated_positions columns to user_map_preferences
 *
 * These boolean columns allow the "Show Accuracy Regions" and "Show Estimated Positions"
 * map feature toggles to persist across page reloads, matching all other map toggles.
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

/**
 * SQLite migration: Add show_accuracy_regions and show_estimated_positions columns
 */
export const migration = {
  up: (db: Database): void => {
    logger.debug('Running migration 076: Adding show_accuracy_regions and show_estimated_positions columns...');

    const tableInfo = db.prepare('PRAGMA table_info(user_map_preferences)').all() as Array<{ name: string }>;

    const hasAccuracyRegions = tableInfo.some((col) => col.name === 'show_accuracy_regions');
    if (!hasAccuracyRegions) {
      db.prepare('ALTER TABLE user_map_preferences ADD COLUMN show_accuracy_regions INTEGER DEFAULT 0 CHECK (show_accuracy_regions IN (0, 1))').run();
      logger.debug('✅ Added show_accuracy_regions column to user_map_preferences');
    } else {
      logger.debug('Column show_accuracy_regions already exists, skipping');
    }

    const hasEstimatedPositions = tableInfo.some((col) => col.name === 'show_estimated_positions');
    if (!hasEstimatedPositions) {
      db.prepare('ALTER TABLE user_map_preferences ADD COLUMN show_estimated_positions INTEGER DEFAULT 1 CHECK (show_estimated_positions IN (0, 1))').run();
      logger.debug('✅ Added show_estimated_positions column to user_map_preferences');
    } else {
      logger.debug('Column show_estimated_positions already exists, skipping');
    }
  },

  down: (_db: Database): void => {
    logger.debug('Migration 076 down: SQLite does not support dropping columns');
  },
};

/**
 * PostgreSQL migration: Add show_accuracy_regions and show_estimated_positions columns
 */
export async function runMigration076Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info('Running migration 076 (PostgreSQL): Adding show_accuracy_regions and show_estimated_positions columns...');

  try {
    const result1 = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'user_map_preferences' AND column_name = 'show_accuracy_regions'
    `);

    if (result1.rows.length === 0) {
      await client.query(`
        ALTER TABLE user_map_preferences
        ADD COLUMN show_accuracy_regions BOOLEAN DEFAULT FALSE
      `);
      logger.debug('✅ Added show_accuracy_regions column to user_map_preferences');
    } else {
      logger.debug('Column show_accuracy_regions already exists, skipping');
    }

    const result2 = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'user_map_preferences' AND column_name = 'show_estimated_positions'
    `);

    if (result2.rows.length === 0) {
      await client.query(`
        ALTER TABLE user_map_preferences
        ADD COLUMN show_estimated_positions BOOLEAN DEFAULT TRUE
      `);
      logger.debug('✅ Added show_estimated_positions column to user_map_preferences');
    } else {
      logger.debug('Column show_estimated_positions already exists, skipping');
    }
  } catch (error: any) {
    logger.error('Failed to add accuracy/estimated position columns:', error.message);
    throw error;
  }

  logger.info('✅ Migration 076 complete (PostgreSQL)');
}

/**
 * MySQL migration: Add show_accuracy_regions and show_estimated_positions columns
 */
export async function runMigration076Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info('Running migration 076 (MySQL): Adding show_accuracy_regions and show_estimated_positions columns...');

  try {
    const [rows1] = await pool.query(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = 'user_map_preferences' AND COLUMN_NAME = 'show_accuracy_regions'
    `);

    if ((rows1 as any[]).length === 0) {
      await pool.query(`
        ALTER TABLE user_map_preferences
        ADD COLUMN show_accuracy_regions TINYINT(1) DEFAULT 0
      `);
      logger.debug('✅ Added show_accuracy_regions column to user_map_preferences');
    } else {
      logger.debug('Column show_accuracy_regions already exists, skipping');
    }

    const [rows2] = await pool.query(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = 'user_map_preferences' AND COLUMN_NAME = 'show_estimated_positions'
    `);

    if ((rows2 as any[]).length === 0) {
      await pool.query(`
        ALTER TABLE user_map_preferences
        ADD COLUMN show_estimated_positions TINYINT(1) DEFAULT 1
      `);
      logger.debug('✅ Added show_estimated_positions column to user_map_preferences');
    } else {
      logger.debug('Column show_estimated_positions already exists, skipping');
    }
  } catch (error: any) {
    logger.error('Failed to add accuracy/estimated position columns:', error.message);
    throw error;
  }

  logger.info('✅ Migration 076 complete (MySQL)');
}
