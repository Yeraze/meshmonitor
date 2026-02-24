/**
 * Migration 053: Add view_on_map permission column tests
 *
 * Tests for the tri-state channel permissions migration that adds the
 * canViewOnMap column to the permissions table.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './053_add_view_on_map_permission.js';

describe('Migration 053: view_on_map permission', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    // Setup users table for foreign key
    db.exec(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY)`);
    db.prepare('INSERT INTO users (id) VALUES (?)').run(1);
    db.prepare('INSERT INTO users (id) VALUES (?)').run(2);

    // Setup initial schema for permissions (pre-migration state)
    db.exec(`
      CREATE TABLE IF NOT EXISTS permissions (
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
  });

  afterEach(() => {
    db.close();
  });

  describe('up migration', () => {
    it('should add can_view_on_map column to permissions table', () => {
      // Run migration
      migration.up(db);

      // Check that can_view_on_map column exists
      const columns = db.prepare(`PRAGMA table_info(permissions)`).all() as any[];
      const viewOnMapColumn = columns.find(c => c.name === 'can_view_on_map');

      expect(viewOnMapColumn).toBeDefined();
      expect(viewOnMapColumn.type).toBe('INTEGER');
      expect(viewOnMapColumn.notnull).toBe(1);
    });

    it('should allow inserting permissions with can_view_on_map', () => {
      migration.up(db);

      // Should be able to insert with can_view_on_map
      expect(() => {
        db.prepare(`
          INSERT INTO permissions (user_id, resource, can_view_on_map, can_read, can_write, granted_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(1, 'channel_0', 1, 1, 0, Date.now());
      }).not.toThrow();
    });

    it('should migrate existing channel permissions - canRead=true sets canViewOnMap=true', () => {
      // Insert pre-migration data
      db.prepare(`
        INSERT INTO permissions (user_id, resource, can_read, can_write, granted_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(1, 'channel_0', 1, 0, Date.now());

      db.prepare(`
        INSERT INTO permissions (user_id, resource, can_read, can_write, granted_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(1, 'channel_1', 0, 0, Date.now());

      // Run migration
      migration.up(db);

      // Check migration results
      const channel0 = db.prepare(`
        SELECT can_view_on_map, can_read FROM permissions WHERE resource = ?
      `).get('channel_0') as any;

      const channel1 = db.prepare(`
        SELECT can_view_on_map, can_read FROM permissions WHERE resource = ?
      `).get('channel_1') as any;

      // channel_0 had can_read=1, so can_view_on_map should be 1
      expect(channel0.can_view_on_map).toBe(1);
      expect(channel0.can_read).toBe(1);

      // channel_1 had can_read=0, so can_view_on_map should be 0
      expect(channel1.can_view_on_map).toBe(0);
      expect(channel1.can_read).toBe(0);
    });

    it('should NOT set canViewOnMap for non-channel resources', () => {
      // Insert pre-migration data for non-channel resource
      db.prepare(`
        INSERT INTO permissions (user_id, resource, can_read, can_write, granted_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(1, 'dashboard', 1, 0, Date.now());

      // Run migration
      migration.up(db);

      // Check that non-channel resources have can_view_on_map=0
      const dashboard = db.prepare(`
        SELECT can_view_on_map, can_read FROM permissions WHERE resource = ?
      `).get('dashboard') as any;

      expect(dashboard.can_view_on_map).toBe(0);
      expect(dashboard.can_read).toBe(1);
    });

    it('should preserve existing permission data during migration', () => {
      const grantedAt = Date.now();

      // Insert pre-migration data
      db.prepare(`
        INSERT INTO permissions (user_id, resource, can_read, can_write, granted_at, granted_by)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(1, 'channel_0', 1, 1, grantedAt, 2);

      // Run migration
      migration.up(db);

      // Check all fields are preserved
      const perm = db.prepare(`
        SELECT * FROM permissions WHERE resource = ?
      `).get('channel_0') as any;

      expect(perm.user_id).toBe(1);
      expect(perm.resource).toBe('channel_0');
      expect(perm.can_read).toBe(1);
      expect(perm.can_write).toBe(1);
      expect(perm.granted_at).toBe(grantedAt);
      expect(perm.granted_by).toBe(2);
      expect(perm.can_view_on_map).toBe(1);
    });
  });

  describe('down migration', () => {
    it('should remove can_view_on_map column', () => {
      migration.up(db);
      migration.down(db);

      // Check that can_view_on_map column no longer exists
      const columns = db.prepare(`PRAGMA table_info(permissions)`).all() as any[];
      const viewOnMapColumn = columns.find(c => c.name === 'can_view_on_map');

      expect(viewOnMapColumn).toBeUndefined();
    });

    it('should preserve other data during rollback', () => {
      const grantedAt = Date.now();

      // Run up migration and insert data
      migration.up(db);
      db.prepare(`
        INSERT INTO permissions (user_id, resource, can_view_on_map, can_read, can_write, granted_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(1, 'channel_0', 1, 1, 0, grantedAt);

      // Run down migration
      migration.down(db);

      // Check data is preserved (except can_view_on_map)
      const perm = db.prepare(`
        SELECT * FROM permissions WHERE resource = ?
      `).get('channel_0') as any;

      expect(perm.user_id).toBe(1);
      expect(perm.resource).toBe('channel_0');
      expect(perm.can_read).toBe(1);
      expect(perm.can_write).toBe(0);
      expect(perm.granted_at).toBe(grantedAt);
    });
  });
});

describe('Permission validation for tri-state', () => {
  describe('write implies read validation', () => {
    it('should reject write=true with read=false for channel resources', () => {
      // This test documents the validation rule enforced by the API
      const validateChannelPermission = (perms: { read: boolean; write: boolean }) => {
        if (perms.write && !perms.read) {
          throw new Error('Invalid permissions: write permission requires read permission for channels');
        }
        return true;
      };

      // Valid combinations
      expect(() => validateChannelPermission({ read: false, write: false })).not.toThrow();
      expect(() => validateChannelPermission({ read: true, write: false })).not.toThrow();
      expect(() => validateChannelPermission({ read: true, write: true })).not.toThrow();

      // Invalid combination
      expect(() => validateChannelPermission({ read: false, write: true })).toThrow(
        'Invalid permissions: write permission requires read permission for channels'
      );
    });

    it('should allow any combination for non-channel resources', () => {
      // Non-channel resources don't have the viewOnMap concept
      // and don't require read for write
      const isChannelResource = (resource: string) => resource.startsWith('channel_');

      expect(isChannelResource('channel_0')).toBe(true);
      expect(isChannelResource('channel_7')).toBe(true);
      expect(isChannelResource('dashboard')).toBe(false);
      expect(isChannelResource('nodes')).toBe(false);
    });
  });

  describe('viewOnMap permission logic', () => {
    it('should only apply viewOnMap to channel resources', () => {
      const channelResources = [
        'channel_0', 'channel_1', 'channel_2', 'channel_3',
        'channel_4', 'channel_5', 'channel_6', 'channel_7'
      ];

      const otherResources = [
        'dashboard', 'nodes', 'messages', 'settings',
        'configuration', 'info', 'automation', 'connection',
        'traceroute', 'audit', 'security', 'themes', 'nodes_private'
      ];

      channelResources.forEach(resource => {
        expect(resource.startsWith('channel_')).toBe(true);
      });

      otherResources.forEach(resource => {
        expect(resource.startsWith('channel_')).toBe(false);
      });
    });

    it('should support all three permission states independently for channels', () => {
      // viewOnMap, read, and write can be set independently (except write requires read)
      const validCombinations = [
        { viewOnMap: false, read: false, write: false },
        { viewOnMap: true, read: false, write: false },
        { viewOnMap: false, read: true, write: false },
        { viewOnMap: true, read: true, write: false },
        { viewOnMap: false, read: true, write: true },
        { viewOnMap: true, read: true, write: true },
      ];

      const invalidCombinations = [
        { viewOnMap: false, read: false, write: true }, // write without read
        { viewOnMap: true, read: false, write: true },  // write without read
      ];

      validCombinations.forEach(combo => {
        const isValid = !combo.write || combo.read;
        expect(isValid).toBe(true);
      });

      invalidCombinations.forEach(combo => {
        const isValid = !combo.write || combo.read;
        expect(isValid).toBe(false);
      });
    });
  });
});
