/**
 * Migration 022: Add custom_themes table
 *
 * Creates a new table to store user-created custom themes with all 28
 * CSS color variables. Enables system-wide custom themes that can be
 * created by admins and used by all users.
 *
 * This enables:
 * - Custom theme creation with visual editor
 * - Import/export of theme definitions
 * - Live preview and accessibility validation
 * - Clone existing themes as starting points
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database): void => {
    logger.debug('Running migration 022: Add custom_themes table and themes permission');

    try {
      // STEP 1: Recreate permissions table with 'themes' in CHECK constraint
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
            'configuration', 'info', 'automation', 'connection', 'traceroute', 'audit', 'security', 'themes'
          ))
        )
      `);
      logger.debug('✅ Created permissions_new table with themes resource');

      // STEP 2: Copy data from old table to new table
      db.exec(`
        INSERT INTO permissions_new
        SELECT * FROM permissions
      `);
      logger.debug('✅ Copied permissions data');

      // STEP 3: Drop old table and rename new table
      db.exec(`DROP TABLE permissions`);
      db.exec(`ALTER TABLE permissions_new RENAME TO permissions`);
      logger.debug('✅ Replaced permissions table');

      // STEP 4: Recreate indices
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_permissions_user_id ON permissions(user_id);
        CREATE INDEX IF NOT EXISTS idx_permissions_resource ON permissions(resource);
      `);
      logger.debug('✅ Recreated permissions indices');

      // STEP 5: Grant themes permissions to all existing admin users
      const now = Date.now();
      db.exec(`
        INSERT OR IGNORE INTO permissions (user_id, resource, can_read, can_write, granted_at, granted_by)
        SELECT id, 'themes', 1, 1, ${now}, id
        FROM users
        WHERE is_admin = 1
      `);
      logger.debug('✅ Granted themes permissions to all admin users');

      // STEP 6: Create custom_themes table to store user-created themes
      db.exec(`
        CREATE TABLE IF NOT EXISTS custom_themes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          definition TEXT NOT NULL,
          is_builtin INTEGER NOT NULL DEFAULT 0,
          created_by INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
        )
      `);
      logger.debug('✅ Created custom_themes table');

      // STEP 7: Create indices on custom_themes
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_themes_slug ON custom_themes(slug);
        CREATE INDEX IF NOT EXISTS idx_custom_themes_created_by ON custom_themes(created_by);
        CREATE INDEX IF NOT EXISTS idx_custom_themes_is_builtin ON custom_themes(is_builtin);
      `);
      logger.debug('✅ Created custom_themes indices');

      logger.debug('✅ Migration 022 completed successfully');
      logger.debug('ℹ️  Custom themes will be stored as JSON in the definition column with all 28 color variables');
    } catch (error: any) {
      if (error.message && error.message.includes('already exists')) {
        logger.debug('⏭️  custom_themes table already exists, skipping');
      } else {
        logger.error('❌ Migration 022 failed:', error);
        throw error;
      }
    }
  },

  down: (db: Database): void => {
    logger.debug('Reverting migration 022: Remove custom_themes table');

    try {
      db.exec('DROP TABLE IF EXISTS custom_themes');
      logger.debug('✅ Migration 022 reverted');
    } catch (error) {
      logger.error('❌ Migration 022 rollback failed:', error);
      throw error;
    }
  }
};
