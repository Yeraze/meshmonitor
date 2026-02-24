/**
 * Migration 016: Add 'security' to permissions resource CHECK constraint
 *
 * Adds the 'security' resource type to the permissions table CHECK constraint
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database): void => {
    logger.debug('Running migration 016: Add security permission resource');

    try {
      // SQLite doesn't support ALTER TABLE to modify CHECK constraints
      // We need to recreate the table with the new constraint

      // 1. Create new permissions table with updated constraint
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
            'dashboard', 'nodes', 'channels', 'messages', 'settings',
            'configuration', 'info', 'automation', 'connection', 'traceroute', 'audit', 'security'
          ))
        )
      `);

      // 2. Copy data from old table to new table
      db.exec(`
        INSERT INTO permissions_new
        SELECT * FROM permissions
      `);

      // 3. Drop old table
      db.exec(`DROP TABLE permissions`);

      // 4. Rename new table to permissions
      db.exec(`ALTER TABLE permissions_new RENAME TO permissions`);

      // 5. Recreate indices
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_permissions_user_id ON permissions(user_id);
        CREATE INDEX IF NOT EXISTS idx_permissions_resource ON permissions(resource);
      `);

      // 6. Grant security permissions to all existing admin users
      const now = Date.now();
      db.exec(`
        INSERT OR IGNORE INTO permissions (user_id, resource, can_read, can_write, granted_at, granted_by)
        SELECT id, 'security', 1, 1, ${now}, id
        FROM users
        WHERE is_admin = 1
      `);
      logger.debug('✅ Granted security permissions to all admin users');

      logger.debug('✅ Migration 016 completed: security resource added');
    } catch (error) {
      logger.error('❌ Migration 016 failed:', error);
      throw error;
    }
  },

  down: (db: Database): void => {
    logger.debug('Running migration 016 down: Remove security permission resource');

    try {
      // Remove security permissions first
      db.exec(`DELETE FROM permissions WHERE resource = 'security'`);

      // Recreate table without security in CHECK constraint
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
            'dashboard', 'nodes', 'channels', 'messages', 'settings',
            'configuration', 'info', 'automation', 'connection', 'traceroute', 'audit'
          ))
        )
      `);

      db.exec(`
        INSERT INTO permissions_new
        SELECT * FROM permissions
      `);

      db.exec(`DROP TABLE permissions`);
      db.exec(`ALTER TABLE permissions_new RENAME TO permissions`);

      // Recreate indices
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_permissions_user_id ON permissions(user_id);
        CREATE INDEX IF NOT EXISTS idx_permissions_resource ON permissions(resource);
      `);

      logger.debug('✅ Migration 016 rollback completed');
    } catch (error) {
      logger.error('❌ Migration 016 rollback failed:', error);
      throw error;
    }
  }
};
