/**
 * Migration 082: Add packetmonitor permission resource
 *
 * Updates the CHECK constraint on the permissions table to include the 'packetmonitor'
 * resource, which allows granular control over who can access the Packet Monitor.
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database): void => {
    logger.debug('Running migration 082: Add packetmonitor permission');

    try {
      // Step 1: Create new permissions table with updated CHECK constraint
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
            'nodes_private', 'meshcore', 'packetmonitor'
          ))
        )
      `);

      // Step 2: Copy all existing permissions to the new table
      db.exec(`
        INSERT INTO permissions_new (user_id, resource, can_view_on_map, can_read, can_write, granted_at, granted_by)
        SELECT user_id, resource, can_view_on_map, can_read, can_write, granted_at, granted_by FROM permissions
      `);

      // Step 3: Drop old table and rename new table
      db.exec(`DROP TABLE permissions`);
      db.exec(`ALTER TABLE permissions_new RENAME TO permissions`);

      // Step 4: Recreate indices
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_permissions_user_id ON permissions(user_id);
        CREATE INDEX IF NOT EXISTS idx_permissions_resource ON permissions(resource);
      `);

      logger.debug('Migration 082 completed: packetmonitor resource added');
    } catch (error) {
      logger.error('Migration 082 failed:', error);
      throw error;
    }
  },

  down: (db: Database): void => {
    logger.debug('Running migration 082 down: Remove packetmonitor resource');

    try {
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
            'nodes_private', 'meshcore'
          ))
        )
      `);

      db.exec(`
        INSERT INTO permissions_new (user_id, resource, can_view_on_map, can_read, can_write, granted_at, granted_by)
        SELECT user_id, resource, can_view_on_map, can_read, can_write, granted_at, granted_by FROM permissions
        WHERE resource != 'packetmonitor'
      `);

      db.exec(`DROP TABLE permissions`);
      db.exec(`ALTER TABLE permissions_new RENAME TO permissions`);

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_permissions_user_id ON permissions(user_id);
        CREATE INDEX IF NOT EXISTS idx_permissions_resource ON permissions(resource);
      `);

      logger.debug('Migration 082 rollback completed');
    } catch (error) {
      logger.error('Migration 082 rollback failed:', error);
      throw error;
    }
  }
};

/**
 * PostgreSQL migration: packetmonitor resource is just a new value, no schema change needed
 */
export async function runMigration082Postgres(_client: import('pg').PoolClient): Promise<void> {
  logger.debug('Migration 082 (PostgreSQL): packetmonitor resource supported (no schema change needed)');
}

/**
 * MySQL migration: packetmonitor resource is just a new value, no schema change needed
 */
export async function runMigration082Mysql(_pool: import('mysql2/promise').Pool): Promise<void> {
  logger.debug('Migration 082 (MySQL): packetmonitor resource supported (no schema change needed)');
}
