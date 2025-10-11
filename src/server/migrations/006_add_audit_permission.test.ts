/**
 * Migration 006 Tests: Add Audit Permission
 *
 * Tests the migration that adds 'audit' to the permissions resource CHECK constraint
 * and grants audit permissions to existing admin users
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './006_add_audit_permission.js';

describe('Migration 006: Add Audit Permission', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');

    // Create prerequisite tables (from previous migrations)
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT,
        email TEXT,
        display_name TEXT,
        auth_provider TEXT NOT NULL DEFAULT 'local',
        oidc_sub TEXT,
        is_admin INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_login_at INTEGER,
        CHECK (is_admin IN (0, 1)),
        CHECK (is_active IN (0, 1)),
        CHECK (auth_provider IN ('local', 'oidc'))
      )
    `);

    // Create permissions table WITHOUT audit in CHECK constraint (pre-migration state)
    db.exec(`
      CREATE TABLE permissions (
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

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_permissions_user_id ON permissions(user_id);
      CREATE INDEX IF NOT EXISTS idx_permissions_resource ON permissions(resource);
    `);

    // Create test users
    db.prepare(`
      INSERT INTO users (username, email, auth_provider, is_admin, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('admin1', 'admin1@example.com', 'local', 1, Date.now());

    db.prepare(`
      INSERT INTO users (username, email, auth_provider, is_admin, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('admin2', 'admin2@example.com', 'local', 1, Date.now());

    db.prepare(`
      INSERT INTO users (username, email, auth_provider, is_admin, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('user1', 'user1@example.com', 'local', 0, Date.now());

    // Add some existing permissions
    const now = Date.now();
    db.prepare(`
      INSERT INTO permissions (user_id, resource, can_read, can_write, granted_at, granted_by)
      VALUES (1, 'dashboard', 1, 1, ${now}, 1)
    `).run();

    db.prepare(`
      INSERT INTO permissions (user_id, resource, can_read, can_write, granted_at, granted_by)
      VALUES (2, 'nodes', 1, 1, ${now}, 1)
    `).run();

    db.prepare(`
      INSERT INTO permissions (user_id, resource, can_read, can_write, granted_at, granted_by)
      VALUES (3, 'dashboard', 1, 0, ${now}, 1)
    `).run();
  });

  describe('up() migration', () => {
    it('should successfully run without errors', () => {
      expect(() => migration.up(db)).not.toThrow();
    });

    it('should add audit to CHECK constraint', () => {
      migration.up(db);

      // Try to insert an audit permission - should succeed
      const now = Date.now();
      expect(() => {
        db.prepare(`
          INSERT INTO permissions (user_id, resource, can_read, can_write, granted_at, granted_by)
          VALUES (1, 'audit', 1, 1, ?, 1)
        `).run(now);
      }).not.toThrow();
    });

    it('should reject invalid resources after migration', () => {
      migration.up(db);

      const now = Date.now();
      expect(() => {
        db.prepare(`
          INSERT INTO permissions (user_id, resource, can_read, can_write, granted_at, granted_by)
          VALUES (1, 'invalid_resource', 1, 1, ?, 1)
        `).run(now);
      }).toThrow();
    });

    it('should preserve existing permissions data', () => {
      const beforeCount = db.prepare('SELECT COUNT(*) as count FROM permissions').get() as { count: number };
      expect(beforeCount.count).toBe(3);

      migration.up(db);

      const afterCount = db.prepare('SELECT COUNT(*) as count FROM permissions').get() as { count: number };
      expect(afterCount.count).toBeGreaterThanOrEqual(3); // At least the original 3, plus audit permissions

      // Check that original permissions are intact
      const dashboardPerm = db.prepare(`
        SELECT * FROM permissions WHERE user_id = 1 AND resource = 'dashboard'
      `).get();
      expect(dashboardPerm).toBeDefined();
    });

    it('should grant audit permissions to all admin users', () => {
      migration.up(db);

      const auditPermissions = db.prepare(`
        SELECT p.*, u.username
        FROM permissions p
        JOIN users u ON p.user_id = u.id
        WHERE p.resource = 'audit' AND u.is_admin = 1
      `).all();

      expect(auditPermissions).toHaveLength(2); // admin1 and admin2
      auditPermissions.forEach((perm: any) => {
        expect(perm.can_read).toBe(1);
        expect(perm.can_write).toBe(1);
      });
    });

    it('should not grant audit permissions to non-admin users', () => {
      migration.up(db);

      const userAuditPermissions = db.prepare(`
        SELECT p.*
        FROM permissions p
        JOIN users u ON p.user_id = u.id
        WHERE p.resource = 'audit' AND u.is_admin = 0
      `).all();

      expect(userAuditPermissions).toHaveLength(0);
    });

    it('should use INSERT OR IGNORE to handle duplicates', () => {
      // Run migration twice
      migration.up(db);
      expect(() => migration.up(db)).not.toThrow();

      // Should still only have one audit permission per admin
      const auditPermissions = db.prepare(`
        SELECT COUNT(*) as count
        FROM permissions
        WHERE resource = 'audit'
      `).get() as { count: number };

      expect(auditPermissions.count).toBe(2); // One for each admin
    });

    it('should recreate indexes', () => {
      migration.up(db);

      // Check that indexes exist by trying to query with them
      const indexQuery = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'index'
        AND tbl_name = 'permissions'
      `).all();

      const indexNames = indexQuery.map((row: any) => row.name);
      expect(indexNames).toContain('idx_permissions_user_id');
      expect(indexNames).toContain('idx_permissions_resource');
    });

    it('should maintain foreign key constraints', () => {
      migration.up(db);

      // Try to insert permission with invalid user_id - should fail
      const now = Date.now();
      expect(() => {
        db.prepare(`
          INSERT INTO permissions (user_id, resource, can_read, can_write, granted_at, granted_by)
          VALUES (9999, 'audit', 1, 1, ?, 1)
        `).run(now);
      }).toThrow();
    });

    it('should maintain UNIQUE constraint on (user_id, resource)', () => {
      migration.up(db);

      const now = Date.now();
      // Try to insert duplicate audit permission - should fail
      expect(() => {
        db.prepare(`
          INSERT INTO permissions (user_id, resource, can_read, can_write, granted_at, granted_by)
          VALUES (1, 'audit', 1, 1, ?, 1)
        `).run(now);
      }).toThrow();
    });
  });

  describe('down() migration', () => {
    beforeEach(() => {
      // Run up migration first
      migration.up(db);
    });

    it('should successfully rollback without errors', () => {
      expect(() => migration.down(db)).not.toThrow();
    });

    it('should remove all audit permissions', () => {
      const beforeCount = db.prepare(`
        SELECT COUNT(*) as count FROM permissions WHERE resource = 'audit'
      `).get() as { count: number };
      expect(beforeCount.count).toBeGreaterThan(0);

      migration.down(db);

      const afterCount = db.prepare(`
        SELECT COUNT(*) as count FROM permissions WHERE resource = 'audit'
      `).get() as { count: number };
      expect(afterCount.count).toBe(0);
    });

    it('should remove audit from CHECK constraint', () => {
      migration.down(db);

      // Try to insert an audit permission - should fail
      const now = Date.now();
      expect(() => {
        db.prepare(`
          INSERT INTO permissions (user_id, resource, can_read, can_write, granted_at, granted_by)
          VALUES (1, 'audit', 1, 1, ?, 1)
        `).run(now);
      }).toThrow();
    });

    it('should preserve non-audit permissions', () => {
      const beforeNonAudit = db.prepare(`
        SELECT COUNT(*) as count FROM permissions WHERE resource != 'audit'
      `).get() as { count: number };

      migration.down(db);

      const afterNonAudit = db.prepare(`
        SELECT COUNT(*) as count FROM permissions WHERE resource != 'audit'
      `).get() as { count: number };

      expect(afterNonAudit.count).toBe(beforeNonAudit.count);
    });

    it('should still allow other valid resources', () => {
      migration.down(db);

      const now = Date.now();
      expect(() => {
        db.prepare(`
          INSERT INTO permissions (user_id, resource, can_read, can_write, granted_at, granted_by)
          VALUES (1, 'traceroute', 1, 1, ?, 1)
        `).run(now);
      }).not.toThrow();
    });

    it('should recreate indexes after rollback', () => {
      migration.down(db);

      const indexQuery = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'index'
        AND tbl_name = 'permissions'
      `).all();

      const indexNames = indexQuery.map((row: any) => row.name);
      expect(indexNames).toContain('idx_permissions_user_id');
      expect(indexNames).toContain('idx_permissions_resource');
    });
  });

  describe('Idempotency', () => {
    it('should handle running up migration multiple times', () => {
      migration.up(db);
      expect(() => migration.up(db)).not.toThrow();

      // Verify data integrity
      const auditPermCount = db.prepare(`
        SELECT COUNT(*) as count FROM permissions WHERE resource = 'audit'
      `).get() as { count: number };

      expect(auditPermCount.count).toBe(2); // Should still be 2 (one per admin)
    });

    it('should handle down -> up -> down cycle', () => {
      migration.up(db);
      migration.down(db);
      migration.up(db);
      migration.down(db);

      // Should be back to original state
      const auditPermCount = db.prepare(`
        SELECT COUNT(*) as count FROM permissions WHERE resource = 'audit'
      `).get() as { count: number };
      expect(auditPermCount.count).toBe(0);

      // Original permissions should still exist
      const originalPermCount = db.prepare(`
        SELECT COUNT(*) as count FROM permissions
      `).get() as { count: number };
      expect(originalPermCount.count).toBe(3);
    });
  });

  describe('Edge Cases', () => {
    it('should handle database with no admin users', () => {
      // Delete all admin users
      db.prepare('DELETE FROM users WHERE is_admin = 1').run();

      expect(() => migration.up(db)).not.toThrow();

      const auditPermCount = db.prepare(`
        SELECT COUNT(*) as count FROM permissions WHERE resource = 'audit'
      `).get() as { count: number };
      expect(auditPermCount.count).toBe(0);
    });

    it('should handle database with no users at all', () => {
      db.prepare('DELETE FROM permissions').run();
      db.prepare('DELETE FROM users').run();

      expect(() => migration.up(db)).not.toThrow();

      const auditPermCount = db.prepare(`
        SELECT COUNT(*) as count FROM permissions WHERE resource = 'audit'
      `).get() as { count: number };
      expect(auditPermCount.count).toBe(0);
    });

    it('should handle admin user that already has some permissions', () => {
      // Admin1 already has dashboard permission
      migration.up(db);

      const admin1Perms = db.prepare(`
        SELECT * FROM permissions WHERE user_id = 1
      `).all();

      // Should have both dashboard (existing) and audit (new)
      expect(admin1Perms.length).toBeGreaterThanOrEqual(2);

      const hasAudit = admin1Perms.some((p: any) => p.resource === 'audit');
      expect(hasAudit).toBe(true);
    });
  });
});
