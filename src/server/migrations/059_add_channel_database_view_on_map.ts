/**
 * Migration 059: Add can_view_on_map permission column to channel_database_permissions
 *
 * Adds a new column to control whether users can see nodes on the map for virtual
 * channels (channel database entries). This enables separate permissions for:
 * - canViewOnMap: can see node positions on map for this virtual channel
 * - canRead: can read messages from this virtual channel
 *
 * Existing permissions are migrated: canRead = true -> canViewOnMap = true
 * to preserve current behavior where read access included map visibility.
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database): void => {
    logger.debug('Running migration 059: Add can_view_on_map to channel_database_permissions');

    try {
      // Step 1: Create new permissions table with can_view_on_map column
      db.exec(`
        CREATE TABLE channel_database_permissions_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          channel_database_id INTEGER NOT NULL,
          can_view_on_map INTEGER NOT NULL DEFAULT 0,
          can_read INTEGER NOT NULL DEFAULT 0,
          granted_by INTEGER,
          granted_at INTEGER NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (channel_database_id) REFERENCES channel_database(id) ON DELETE CASCADE,
          FOREIGN KEY (granted_by) REFERENCES users(id) ON DELETE SET NULL,
          UNIQUE(user_id, channel_database_id),
          CHECK (can_view_on_map IN (0, 1)),
          CHECK (can_read IN (0, 1))
        )
      `);

      // Step 2: Copy existing permissions, setting can_view_on_map = can_read
      // This preserves existing behavior where read permission implied map visibility
      db.exec(`
        INSERT INTO channel_database_permissions_new (id, user_id, channel_database_id, can_view_on_map, can_read, granted_by, granted_at)
        SELECT id, user_id, channel_database_id, can_read, can_read, granted_by, granted_at
        FROM channel_database_permissions
      `);

      // Step 3: Drop old table and rename new table
      db.exec(`DROP TABLE channel_database_permissions`);
      db.exec(`ALTER TABLE channel_database_permissions_new RENAME TO channel_database_permissions`);

      // Step 4: Recreate indices
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_channel_database_permissions_user ON channel_database_permissions(user_id);
        CREATE INDEX IF NOT EXISTS idx_channel_database_permissions_channel ON channel_database_permissions(channel_database_id);
      `);

      logger.debug('Migration 059 completed: can_view_on_map column added to channel_database_permissions');
    } catch (error) {
      logger.error('Migration 059 failed:', error);
      throw error;
    }
  },

  down: (db: Database): void => {
    logger.debug('Running migration 059 down: Remove can_view_on_map column');

    try {
      // Step 1: Create permissions table without can_view_on_map column
      db.exec(`
        CREATE TABLE channel_database_permissions_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          channel_database_id INTEGER NOT NULL,
          can_read INTEGER NOT NULL DEFAULT 0,
          granted_by INTEGER,
          granted_at INTEGER NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (channel_database_id) REFERENCES channel_database(id) ON DELETE CASCADE,
          FOREIGN KEY (granted_by) REFERENCES users(id) ON DELETE SET NULL,
          UNIQUE(user_id, channel_database_id),
          CHECK (can_read IN (0, 1))
        )
      `);

      // Step 2: Copy permissions without can_view_on_map
      db.exec(`
        INSERT INTO channel_database_permissions_new (id, user_id, channel_database_id, can_read, granted_by, granted_at)
        SELECT id, user_id, channel_database_id, can_read, granted_by, granted_at
        FROM channel_database_permissions
      `);

      // Step 3: Drop old table and rename new table
      db.exec(`DROP TABLE channel_database_permissions`);
      db.exec(`ALTER TABLE channel_database_permissions_new RENAME TO channel_database_permissions`);

      // Step 4: Recreate indices
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_channel_database_permissions_user ON channel_database_permissions(user_id);
        CREATE INDEX IF NOT EXISTS idx_channel_database_permissions_channel ON channel_database_permissions(channel_database_id);
      `);

      logger.debug('Migration 059 rollback completed');
    } catch (error) {
      logger.error('Migration 059 rollback failed:', error);
      throw error;
    }
  }
};

/**
 * PostgreSQL migration: Add canViewOnMap column to channel_database_permissions
 */
export async function runMigration059Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.debug('Running migration 059 (PostgreSQL): Add canViewOnMap column to channel_database_permissions');

  try {
    // Check if column already exists
    const columnExists = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'channel_database_permissions'
          AND column_name = 'canViewOnMap'
      )
    `);

    if (columnExists.rows[0].exists) {
      logger.debug('canViewOnMap column already exists, skipping migration');
      return;
    }

    // Add the column
    await client.query(`
      ALTER TABLE channel_database_permissions ADD COLUMN "canViewOnMap" BOOLEAN NOT NULL DEFAULT false
    `);

    // Migrate existing data: set canViewOnMap = canRead
    await client.query(`
      UPDATE channel_database_permissions
      SET "canViewOnMap" = "canRead"
    `);

    logger.debug('✅ Migration 059 (PostgreSQL): canViewOnMap column added to channel_database_permissions');
  } catch (error) {
    logger.error('Migration 059 (PostgreSQL) failed:', error);
    throw error;
  }
}

/**
 * MySQL migration: Add canViewOnMap column to channel_database_permissions
 */
export async function runMigration059Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.debug('Running migration 059 (MySQL): Add canViewOnMap column to channel_database_permissions');

  try {
    const connection = await pool.getConnection();
    try {
      // Check if column already exists
      const [columns] = await connection.query(`
        SELECT COLUMN_NAME FROM information_schema.columns
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'channel_database_permissions'
          AND COLUMN_NAME = 'canViewOnMap'
      `);

      if ((columns as any[]).length > 0) {
        logger.debug('canViewOnMap column already exists, skipping migration');
        return;
      }

      // Add the column
      await connection.query(`
        ALTER TABLE channel_database_permissions ADD COLUMN canViewOnMap BOOLEAN NOT NULL DEFAULT false
      `);

      // Migrate existing data: set canViewOnMap = canRead
      await connection.query(`
        UPDATE channel_database_permissions
        SET canViewOnMap = canRead
      `);

      logger.debug('✅ Migration 059 (MySQL): canViewOnMap column added to channel_database_permissions');
    } finally {
      connection.release();
    }
  } catch (error) {
    logger.error('Migration 059 (MySQL) failed:', error);
    throw error;
  }
}
