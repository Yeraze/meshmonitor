/**
 * Migration 043: Add nodes_private permission resource
 *
 * Updates the CHECK constraint on the permissions table to include the 'nodes_private'
 * resource, which allows granular control over who can view private position overrides.
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database): void => {
    logger.debug('Running migration 043: Add nodes_private permission');

    try {
      // Step 1: Create new permissions table with updated CHECK constraint
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

      // Step 2: Copy all existing permissions to the new table
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

      logger.debug('✅ Migration 043 completed: nodes_private resource added');
    } catch (error) {
      logger.error('❌ Migration 043 failed:', error);
      throw error;
    }
  },

  down: (db: Database): void => {
    logger.debug('Running migration 043 down: Remove nodes_private resource');

    try {
      // Step 1: Create new permissions table with old CHECK constraint
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
            'channel_4', 'channel_5', 'channel_6', 'channel_7'
          ))
        )
      `);

      // Step 2: Copy all permissions EXCEPT 'nodes_private'
      db.exec(`
        INSERT INTO permissions_new (user_id, resource, can_read, can_write, granted_at, granted_by)
        SELECT user_id, resource, can_read, can_write, granted_at, granted_by FROM permissions
        WHERE resource != 'nodes_private'
      `);

      // Step 3: Drop old table and rename new table
      db.exec(`DROP TABLE permissions`);
      db.exec(`ALTER TABLE permissions_new RENAME TO permissions`);

      // Step 4: Recreate indices
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_permissions_user_id ON permissions(user_id);
        CREATE INDEX IF NOT EXISTS idx_permissions_resource ON permissions(resource);
      `);

      logger.debug('✅ Migration 043 rollback completed');
    } catch (error) {
      logger.error('❌ Migration 043 rollback failed:', error);
      throw error;
    }
  }
};
