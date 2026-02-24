/**
 * Migration 074: Add show_meshcore_nodes column to user_map_preferences
 *
 * Adds the show_meshcore_nodes boolean column so the "Show MeshCore" map
 * feature toggle persists across page loads, matching all other map toggles.
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

/**
 * SQLite migration: Add show_meshcore_nodes column
 */
export const migration = {
  up: (db: Database): void => {
    logger.debug('Running migration 074: Adding show_meshcore_nodes column...');

    const tableInfo = db.prepare('PRAGMA table_info(user_map_preferences)').all() as Array<{ name: string }>;
    const columnExists = tableInfo.some((col) => col.name === 'show_meshcore_nodes');

    if (!columnExists) {
      db.prepare('ALTER TABLE user_map_preferences ADD COLUMN show_meshcore_nodes INTEGER DEFAULT 1 CHECK (show_meshcore_nodes IN (0, 1))').run();
      logger.debug('✅ Added show_meshcore_nodes column to user_map_preferences');
    } else {
      logger.debug('Column show_meshcore_nodes already exists, skipping');
    }
  },

  down: (_db: Database): void => {
    logger.debug('Migration 074 down: SQLite does not support dropping columns');
  },
};

/**
 * PostgreSQL migration: Add show_meshcore_nodes column
 */
export async function runMigration074Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info('Running migration 074 (PostgreSQL): Adding show_meshcore_nodes column...');

  try {
    const result = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'user_map_preferences' AND column_name = 'show_meshcore_nodes'
    `);

    if (result.rows.length === 0) {
      await client.query(`
        ALTER TABLE user_map_preferences
        ADD COLUMN show_meshcore_nodes BOOLEAN DEFAULT TRUE
      `);
      logger.debug('✅ Added show_meshcore_nodes column to user_map_preferences');
    } else {
      logger.debug('Column show_meshcore_nodes already exists, skipping');
    }
  } catch (error: any) {
    logger.error('Failed to add show_meshcore_nodes column:', error.message);
    throw error;
  }

  logger.info('✅ Migration 074 complete (PostgreSQL)');
}

/**
 * MySQL migration: Add show_meshcore_nodes column
 */
export async function runMigration074Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info('Running migration 074 (MySQL): Adding show_meshcore_nodes column...');

  try {
    const [rows] = await pool.query(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = 'user_map_preferences' AND COLUMN_NAME = 'show_meshcore_nodes'
    `);

    if ((rows as any[]).length === 0) {
      await pool.query(`
        ALTER TABLE user_map_preferences
        ADD COLUMN show_meshcore_nodes TINYINT(1) DEFAULT 1
      `);
      logger.debug('✅ Added show_meshcore_nodes column to user_map_preferences');
    } else {
      logger.debug('Column show_meshcore_nodes already exists, skipping');
    }
  } catch (error: any) {
    logger.error('Failed to add show_meshcore_nodes column:', error.message);
    throw error;
  }

  logger.info('✅ Migration 074 complete (MySQL)');
}
