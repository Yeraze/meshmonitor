/**
 * Migration 024: Add per-channel permissions
 *
 * Replaces the single 'channels' permission resource with 8 separate channel-specific
 * resources (channel_0 through channel_7), allowing granular read/write control
 * for each Meshtastic channel.
 *
 * For existing users with a 'channels' permission, this migration copies that
 * permission to all 8 channel resources, maintaining backward compatibility.
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database): void => {
    logger.debug('Running migration 024: Add per-channel permissions');

    try {
      // Step 1: Get all existing 'channels' permissions before we modify the table
      const existingChannelPermissions = db.prepare(`
        SELECT user_id, can_read, can_write, granted_at, granted_by
        FROM permissions
        WHERE resource = 'channels'
      `).all() as Array<{
        user_id: number;
        can_read: number;
        can_write: number;
        granted_at: number;
        granted_by: number | null;
      }>;

      logger.debug(`Found ${existingChannelPermissions.length} existing 'channels' permissions to migrate`);

      // Step 2: Create new permissions table with updated CHECK constraint
      // including channel_0 through channel_7
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

      // Step 3: Copy all permissions EXCEPT 'channels' to the new table
      db.exec(`
        INSERT INTO permissions_new
        SELECT * FROM permissions
        WHERE resource != 'channels'
      `);

      // Step 4: For each user who had 'channels' permission,
      // create 8 new channel-specific permissions (channel_0 through channel_7)
      const insertStmt = db.prepare(`
        INSERT INTO permissions_new (user_id, resource, can_read, can_write, granted_at, granted_by)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      for (const perm of existingChannelPermissions) {
        for (let channelId = 0; channelId < 8; channelId++) {
          insertStmt.run(
            perm.user_id,
            `channel_${channelId}`,
            perm.can_read,
            perm.can_write,
            perm.granted_at,
            perm.granted_by
          );
        }
      }

      logger.debug(`Created ${existingChannelPermissions.length * 8} new per-channel permissions`);

      // Step 5: Drop old table and rename new table
      db.exec(`DROP TABLE permissions`);
      db.exec(`ALTER TABLE permissions_new RENAME TO permissions`);

      // Step 6: Recreate indices
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_permissions_user_id ON permissions(user_id);
        CREATE INDEX IF NOT EXISTS idx_permissions_resource ON permissions(resource);
      `);

      logger.debug('✅ Migration 024 completed: Per-channel permissions added');
    } catch (error) {
      logger.error('❌ Migration 024 failed:', error);
      throw error;
    }
  },

  down: (db: Database): void => {
    logger.debug('Running migration 024 down: Revert to single channels permission');

    try {
      // Step 1: Collect per-channel permissions to determine overall channels permission
      // Strategy: If user has ANY channel_N permission with can_read=1, set channels.can_read=1
      // If user has ANY channel_N permission with can_write=1, set channels.can_write=1
      const userChannelPerms = db.prepare(`
        SELECT
          user_id,
          MAX(can_read) as can_read,
          MAX(can_write) as can_write,
          MIN(granted_at) as granted_at,
          granted_by
        FROM permissions
        WHERE resource LIKE 'channel_%'
        GROUP BY user_id
      `).all() as Array<{
        user_id: number;
        can_read: number;
        can_write: number;
        granted_at: number;
        granted_by: number | null;
      }>;

      logger.debug(`Found ${userChannelPerms.length} users with channel permissions to consolidate`);

      // Step 2: Create new permissions table with old CHECK constraint (without channel_N)
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
            'configuration', 'info', 'automation', 'connection',
            'traceroute', 'audit', 'security', 'themes'
          ))
        )
      `);

      // Step 3: Copy all non-channel permissions
      db.exec(`
        INSERT INTO permissions_new
        SELECT * FROM permissions
        WHERE resource NOT LIKE 'channel_%'
      `);

      // Step 4: Insert consolidated 'channels' permissions
      const insertStmt = db.prepare(`
        INSERT INTO permissions_new (user_id, resource, can_read, can_write, granted_at, granted_by)
        VALUES (?, 'channels', ?, ?, ?, ?)
      `);

      for (const perm of userChannelPerms) {
        insertStmt.run(
          perm.user_id,
          perm.can_read,
          perm.can_write,
          perm.granted_at,
          perm.granted_by
        );
      }

      logger.debug(`Created ${userChannelPerms.length} consolidated 'channels' permissions`);

      // Step 5: Drop old table and rename new table
      db.exec(`DROP TABLE permissions`);
      db.exec(`ALTER TABLE permissions_new RENAME TO permissions`);

      // Step 6: Recreate indices
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_permissions_user_id ON permissions(user_id);
        CREATE INDEX IF NOT EXISTS idx_permissions_resource ON permissions(resource);
      `);

      logger.debug('✅ Migration 024 rollback completed');
    } catch (error) {
      logger.error('❌ Migration 024 rollback failed:', error);
      throw error;
    }
  }
};
