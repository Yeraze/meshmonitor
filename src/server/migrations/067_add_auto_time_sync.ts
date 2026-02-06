/**
 * Migration 067: Add auto time sync schema changes
 *
 * Adds:
 * - lastTimeSync column to nodes table (tracks when node was last time synced)
 * - auto_time_sync_nodes table (stores which nodes to sync when filtering is enabled)
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database): void => {
    logger.debug('Running migration 067: Add auto time sync schema changes');

    try {
      // Check which columns already exist
      const columns = db.pragma("table_info('nodes')") as Array<{ name: string }>;
      const columnNames = new Set(columns.map((col) => col.name));

      // Add lastTimeSync column to nodes table
      if (!columnNames.has('lastTimeSync')) {
        db.exec(`
          ALTER TABLE nodes ADD COLUMN lastTimeSync INTEGER;
        `);
        logger.debug('Added lastTimeSync column to nodes table');
      } else {
        logger.debug('lastTimeSync column already exists, skipping');
      }

      // Create auto_time_sync_nodes table
      db.exec(`
        CREATE TABLE IF NOT EXISTS auto_time_sync_nodes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          nodeNum INTEGER NOT NULL UNIQUE,
          enabled INTEGER DEFAULT 1,
          createdAt INTEGER NOT NULL
        );
      `);
      logger.debug('Created auto_time_sync_nodes table');

      logger.debug('Migration 067 completed: auto time sync schema changes added');
    } catch (error) {
      logger.error('Migration 067 failed:', error);
      throw error;
    }
  },

  down: (_db: Database): void => {
    logger.debug('Running migration 067 down: Remove auto time sync schema changes');

    try {
      // SQLite doesn't support DROP COLUMN directly until version 3.35.0
      // For older versions, we'd need to recreate the table without the columns
      // But for this case, we'll just note that the columns can remain
      logger.debug('Note: SQLite DROP COLUMN requires version 3.35.0+');
      logger.debug('The auto time sync columns will remain but will not be used');

      logger.debug('Migration 067 rollback completed');
    } catch (error) {
      logger.error('Migration 067 rollback failed:', error);
      throw error;
    }
  }
};

/**
 * PostgreSQL migration: Add auto time sync schema changes
 */
export async function runMigration067Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.debug('Running migration 067 (PostgreSQL): Add auto time sync schema changes');

  try {
    // Check if lastTimeSync column exists
    const lastTimeSyncExists = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'nodes'
          AND column_name = 'lastTimeSync'
      )
    `);

    if (!lastTimeSyncExists.rows[0].exists) {
      await client.query(`
        ALTER TABLE nodes ADD COLUMN "lastTimeSync" BIGINT
      `);
      logger.debug('Added lastTimeSync column to nodes table');
    } else {
      logger.debug('lastTimeSync column already exists, skipping');
    }

    // Create auto_time_sync_nodes table
    await client.query(`
      CREATE TABLE IF NOT EXISTS auto_time_sync_nodes (
        id SERIAL PRIMARY KEY,
        "nodeNum" BIGINT NOT NULL UNIQUE,
        enabled BOOLEAN DEFAULT true,
        "createdAt" BIGINT NOT NULL
      )
    `);
    logger.debug('Created auto_time_sync_nodes table');

    logger.debug('Migration 067 (PostgreSQL): auto time sync schema changes added');
  } catch (error) {
    logger.error('Migration 067 (PostgreSQL) failed:', error);
    throw error;
  }
}

/**
 * MySQL migration: Add auto time sync schema changes
 */
export async function runMigration067Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.debug('Running migration 067 (MySQL): Add auto time sync schema changes');

  try {
    const connection = await pool.getConnection();
    try {
      // Check if lastTimeSync column exists
      const [lastTimeSyncCols] = await connection.query(`
        SELECT COLUMN_NAME FROM information_schema.columns
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'nodes'
          AND COLUMN_NAME = 'lastTimeSync'
      `);

      if ((lastTimeSyncCols as any[]).length === 0) {
        await connection.query(`
          ALTER TABLE nodes ADD COLUMN lastTimeSync BIGINT
        `);
        logger.debug('Added lastTimeSync column to nodes table');
      } else {
        logger.debug('lastTimeSync column already exists, skipping');
      }

      // Create auto_time_sync_nodes table
      await connection.query(`
        CREATE TABLE IF NOT EXISTS auto_time_sync_nodes (
          id INT AUTO_INCREMENT PRIMARY KEY,
          nodeNum BIGINT NOT NULL UNIQUE,
          enabled TINYINT(1) DEFAULT 1,
          createdAt BIGINT NOT NULL
        )
      `);
      logger.debug('Created auto_time_sync_nodes table');

      logger.debug('Migration 067 (MySQL): auto time sync schema changes added');
    } finally {
      connection.release();
    }
  } catch (error) {
    logger.error('Migration 067 (MySQL) failed:', error);
    throw error;
  }
}
