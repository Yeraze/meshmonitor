/**
 * Migration 053: Add can_view_on_map permission column
 *
 * Adds a new column to the permissions table to control whether users can see
 * nodes on the map for each channel. This enables tri-state channel permissions:
 * - View on Map: can see node positions on map for this channel
 * - Read Messages: can read messages from this channel
 * - Send Messages: can send to channel (implies Read Messages)
 *
 * Existing permissions are migrated: canRead = true -> canViewOnMap = true
 * to preserve current behavior where read access included map visibility.
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database): void => {
    logger.debug('Running migration 053: Add can_view_on_map permission column');

    try {
      // Step 1: Create new permissions table with can_view_on_map column
      db.exec(`
        CREATE TABLE permissions_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          resource TEXT NOT NULL,
          can_view_on_map INTEGER NOT NULL DEFAULT 0,
          can_read INTEGER NOT NULL DEFAULT 0,
          can_write INTEGER NOT NULL DEFAULT 0,
          granted_at INTEGER NOT NULL,
          granted_by INTEGER,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (granted_by) REFERENCES users(id),
          UNIQUE(user_id, resource),
          CHECK (can_view_on_map IN (0, 1)),
          CHECK (can_read IN (0, 1)),
          CHECK (can_write IN (0, 1)),
          CHECK (resource IN (
            'dashboard', 'nodes', 'messages', 'settings',
            'configuration', 'info', 'automation', 'connection',
            'traceroute', 'audit', 'security', 'themes',
            'channel_0', 'channel_1', 'channel_2', 'channel_3',
            'channel_4', 'channel_5', 'channel_6', 'channel_7',
            'nodes_private'
          ))
        )
      `);

      // Step 2: Copy existing permissions, setting can_view_on_map = can_read for channel resources
      // This preserves existing behavior where read permission implied map visibility
      db.exec(`
        INSERT INTO permissions_new (user_id, resource, can_view_on_map, can_read, can_write, granted_at, granted_by)
        SELECT
          user_id,
          resource,
          CASE
            WHEN resource LIKE 'channel_%' THEN can_read
            ELSE 0
          END as can_view_on_map,
          can_read,
          can_write,
          granted_at,
          granted_by
        FROM permissions
      `);

      // Step 3: Drop old table and rename new table
      db.exec(`DROP TABLE permissions`);
      db.exec(`ALTER TABLE permissions_new RENAME TO permissions`);

      // Step 4: Recreate indices
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_permissions_user_id ON permissions(user_id);
        CREATE INDEX IF NOT EXISTS idx_permissions_resource ON permissions(resource);
      `);

      logger.debug('Migration 053 completed: can_view_on_map column added');
    } catch (error) {
      logger.error('Migration 053 failed:', error);
      throw error;
    }
  },

  down: (db: Database): void => {
    logger.debug('Running migration 053 down: Remove can_view_on_map column');

    try {
      // Step 1: Create permissions table without can_view_on_map column
      db.exec(`
        CREATE TABLE permissions_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          resource TEXT NOT NULL,
          can_read INTEGER NOT NULL DEFAULT 0,
          can_write INTEGER NOT NULL DEFAULT 0,
          granted_at INTEGER NOT NULL,
          granted_by INTEGER,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (granted_by) REFERENCES users(id),
          UNIQUE(user_id, resource),
          CHECK (can_read IN (0, 1)),
          CHECK (can_write IN (0, 1)),
          CHECK (resource IN (
            'dashboard', 'nodes', 'messages', 'settings',
            'configuration', 'info', 'automation', 'connection',
            'traceroute', 'audit', 'security', 'themes',
            'channel_0', 'channel_1', 'channel_2', 'channel_3',
            'channel_4', 'channel_5', 'channel_6', 'channel_7',
            'nodes_private'
          ))
        )
      `);

      // Step 2: Copy permissions without can_view_on_map
      db.exec(`
        INSERT INTO permissions_new (user_id, resource, can_read, can_write, granted_at, granted_by)
        SELECT user_id, resource, can_read, can_write, granted_at, granted_by FROM permissions
      `);

      // Step 3: Drop old table and rename new table
      db.exec(`DROP TABLE permissions`);
      db.exec(`ALTER TABLE permissions_new RENAME TO permissions`);

      // Step 4: Recreate indices
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_permissions_user_id ON permissions(user_id);
        CREATE INDEX IF NOT EXISTS idx_permissions_resource ON permissions(resource);
      `);

      logger.debug('Migration 053 rollback completed');
    } catch (error) {
      logger.error('Migration 053 rollback failed:', error);
      throw error;
    }
  }
};

/**
 * PostgreSQL migration: Add can_view_on_map column to permissions
 */
export async function runMigration053Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.debug('Running migration 053 (PostgreSQL): Add canViewOnMap column to permissions');

  try {
    // Check if column already exists
    const columnExists = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'permissions'
          AND column_name = 'canViewOnMap'
      )
    `);

    if (columnExists.rows[0].exists) {
      logger.debug('canViewOnMap column already exists, skipping migration');
      return;
    }

    // Add the column
    await client.query(`
      ALTER TABLE permissions ADD COLUMN "canViewOnMap" BOOLEAN NOT NULL DEFAULT false
    `);

    // Migrate existing data: set canViewOnMap = canRead for channel resources
    await client.query(`
      UPDATE permissions
      SET "canViewOnMap" = "canRead"
      WHERE resource LIKE 'channel_%'
    `);

    logger.debug('✅ Migration 053 (PostgreSQL): canViewOnMap column added');
  } catch (error) {
    logger.error('Migration 053 (PostgreSQL) failed:', error);
    throw error;
  }
}

/**
 * MySQL migration: Add canViewOnMap column to permissions
 */
export async function runMigration053Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.debug('Running migration 053 (MySQL): Add canViewOnMap column to permissions');

  try {
    const connection = await pool.getConnection();
    try {
      // Check if column already exists
      const [columns] = await connection.query(`
        SELECT COLUMN_NAME FROM information_schema.columns
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'permissions'
          AND COLUMN_NAME = 'canViewOnMap'
      `);

      if ((columns as any[]).length > 0) {
        logger.debug('canViewOnMap column already exists, skipping migration');
        return;
      }

      // Add the column
      await connection.query(`
        ALTER TABLE permissions ADD COLUMN canViewOnMap BOOLEAN NOT NULL DEFAULT false
      `);

      // Migrate existing data: set canViewOnMap = canRead for channel resources
      await connection.query(`
        UPDATE permissions
        SET canViewOnMap = canRead
        WHERE resource LIKE 'channel_%'
      `);

      logger.debug('✅ Migration 053 (MySQL): canViewOnMap column added');
    } finally {
      connection.release();
    }
  } catch (error) {
    logger.error('Migration 053 (MySQL) failed:', error);
    throw error;
  }
}
