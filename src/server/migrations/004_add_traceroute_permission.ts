/**
 * Migration 004: Add 'traceroute' to permissions resource CHECK constraint
 *
 * Adds the 'traceroute' resource type to the permissions table CHECK constraint
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database): void => {
    logger.debug('Running migration 004: Add traceroute permission resource');

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
            'configuration', 'info', 'automation', 'connection', 'traceroute'
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

      logger.debug('✅ Migration 004 completed: traceroute resource added');
    } catch (error) {
      logger.error('❌ Migration 004 failed:', error);
      throw error;
    }
  },

  down: (db: Database): void => {
    logger.debug('Running migration 004 down: Remove traceroute permission resource');

    try {
      // Remove traceroute permissions first
      db.exec(`DELETE FROM permissions WHERE resource = 'traceroute'`);

      // Recreate table without traceroute in CHECK constraint
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
            'configuration', 'info', 'automation', 'connection'
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

      logger.debug('✅ Migration 004 rollback completed');
    } catch (error) {
      logger.error('❌ Migration 004 rollback failed:', error);
      throw error;
    }
  }
};
