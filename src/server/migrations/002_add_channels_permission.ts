/**
 * Migration 002: Add 'channels' to permissions resource CHECK constraint
 *
 * Adds the 'channels' resource type to the permissions table CHECK constraint
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database): void => {
    logger.debug('Running migration 002: Add channels permission resource');

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
            'configuration', 'info', 'automation'
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

      logger.debug('✅ Migration 002 completed: channels resource added');
    } catch (error) {
      logger.error('❌ Migration 002 failed:', error);
      throw error;
    }
  },

  down: (db: Database): void => {
    logger.debug('Running migration 002 down: Remove channels permission resource');

    try {
      // Remove channels permissions first
      db.exec(`DELETE FROM permissions WHERE resource = 'channels'`);

      // Recreate table without channels in CHECK constraint
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
            'configuration', 'info', 'automation'
          ))
        )
      `);

      db.exec(`
        INSERT INTO permissions_new
        SELECT * FROM permissions
      `);

      db.exec(`DROP TABLE permissions`);
      db.exec(`ALTER TABLE permissions_new RENAME TO permissions`);

      logger.debug('✅ Migration 002 rollback completed');
    } catch (error) {
      logger.error('❌ Migration 002 rollback failed:', error);
      throw error;
    }
  }
};
