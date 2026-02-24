/**
 * Audit Log Routes Integration Tests
 *
 * Tests audit log API endpoints and permission boundaries
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import express, { Express } from 'express';
import session from 'express-session';
import request from 'supertest';
import { UserModel } from '../models/User.js';
import { PermissionModel } from '../models/Permission.js';
import { migration as authMigration } from '../migrations/001_add_auth_tables.js';
import { migration as auditEnhancementMigration } from '../migrations/005_enhance_audit_log.js';
import { migration as auditPermissionMigration } from '../migrations/006_add_audit_permission.js';
import { migration as securityPermissionMigration } from '../migrations/016_add_security_permission.js';
import { migration as themesMigration } from '../migrations/022_add_custom_themes.js';
import { migration as passwordLockedMigration } from '../migrations/023_add_password_locked_flag.js';
import { migration as perChannelPermissionsMigration } from '../migrations/024_add_per_channel_permissions.js';
import { migration as nodesPrivatePermissionMigration } from '../migrations/044_add_nodes_private_permission.js';
import { migration as viewOnMapPermissionMigration } from '../migrations/053_add_view_on_map_permission.js';
import { migration as mfaMigration } from '../migrations/068_add_mfa_columns.js';
import { migration as meshcorePermissionMigration } from '../migrations/071_add_meshcore_permission.js';
import auditRoutes from './auditRoutes.js';
import authRoutes from './authRoutes.js';

// Mock the DatabaseService to prevent auto-initialization
vi.mock('../../services/database.js', () => ({
  default: {}
}));

import DatabaseService from '../../services/database.js';

describe('Audit Log Routes', () => {
  let app: Express;
  let db: Database.Database;
  let userModel: UserModel;
  let permissionModel: PermissionModel;
  let adminUserId: number;
  let regularUserId: number;

  // Helper functions to make authenticated requests
  const asAdmin = () => ({
    get: (url: string) => request(app).get(url)
      .set('x-test-user-id', adminUserId.toString())
      .set('x-test-username', 'admin')
      .set('x-test-is-admin', 'true'),
    post: (url: string) => request(app).post(url)
      .set('x-test-user-id', adminUserId.toString())
      .set('x-test-username', 'admin')
      .set('x-test-is-admin', 'true'),
  });

  const asUser = () => ({
    get: (url: string) => request(app).get(url)
      .set('x-test-user-id', regularUserId.toString())
      .set('x-test-username', 'user')
      .set('x-test-is-admin', 'false'),
    post: (url: string) => request(app).post(url)
      .set('x-test-user-id', regularUserId.toString())
      .set('x-test-username', 'user')
      .set('x-test-is-admin', 'false'),
  });

  beforeAll(() => {
    // Setup express app for testing
    app = express();
    app.use(express.json());
    app.use(
      session({
        secret: 'test-secret',
        resave: false,
        saveUninitialized: false,
        cookie: { secure: false }
      })
    );

    // Setup in-memory database
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');

    // Run migrations
    authMigration.up(db);
    auditEnhancementMigration.up(db);
    auditPermissionMigration.up(db);
    securityPermissionMigration.up(db);
    themesMigration.up(db);
    passwordLockedMigration.up(db);
    perChannelPermissionsMigration.up(db);
    nodesPrivatePermissionMigration.up(db);
    viewOnMapPermissionMigration.up(db);
    mfaMigration.up(db);
    meshcorePermissionMigration.up(db);

    userModel = new UserModel(db);
    permissionModel = new PermissionModel(db);

    // Mock database service methods
    (DatabaseService as any).userModel = userModel;
    (DatabaseService as any).permissionModel = permissionModel;

    // Mock audit log methods
    (DatabaseService as any).auditLog = (
      userId: number | null,
      action: string,
      resource: string | null,
      details: string | null,
      ipAddress: string | null,
      valueBefore?: string | null,
      valueAfter?: string | null
    ) => {
      db.prepare(`
        INSERT INTO audit_log (user_id, action, resource, details, ip_address, value_before, value_after, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(userId, action, resource, details, ipAddress, valueBefore || null, valueAfter || null, Date.now());
    };

    (DatabaseService as any).getAuditLogs = (options: any = {}) => {
      const {
        limit = 100,
        offset = 0,
        userId,
        action,
        excludeAction,
        resource,
        startDate,
        endDate,
        search
      } = options;

      let whereClause = 'WHERE 1=1';
      const params: any[] = [];

      if (userId !== undefined) {
        whereClause += ' AND audit_log.user_id = ?';
        params.push(userId);
      }
      if (action) {
        whereClause += ' AND audit_log.action = ?';
        params.push(action);
      }
      if (excludeAction) {
        whereClause += ' AND audit_log.action != ?';
        params.push(excludeAction);
      }
      if (resource) {
        whereClause += ' AND audit_log.resource = ?';
        params.push(resource);
      }
      if (startDate) {
        whereClause += ' AND audit_log.timestamp >= ?';
        params.push(startDate);
      }
      if (endDate) {
        whereClause += ' AND audit_log.timestamp <= ?';
        params.push(endDate);
      }
      if (search) {
        whereClause += ' AND audit_log.details LIKE ?';
        params.push(`%${search}%`);
      }

      const countStmt = db.prepare(`
        SELECT COUNT(*) as count FROM audit_log ${whereClause}
      `);
      const countResult = countStmt.get(...params) as any;
      const count = countResult?.count || 0;

      const logsStmt = db.prepare(`
        SELECT audit_log.*, users.username
        FROM audit_log
        LEFT JOIN users ON audit_log.user_id = users.id
        ${whereClause}
        ORDER BY audit_log.timestamp DESC
        LIMIT ? OFFSET ?
      `);
      const logs = logsStmt.all(...params, limit, offset);

      return { logs, total: count };
    };

    // Add async version for new unified API
    (DatabaseService as any).getAuditLogsAsync = async (options: any = {}) => {
      return (DatabaseService as any).getAuditLogs(options);
    };

    (DatabaseService as any).getAuditStats = (days: number = 30) => {
      const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);

      return {
        actionStats: db.prepare(`
          SELECT action, COUNT(*) as count
          FROM audit_log
          WHERE timestamp >= ?
          GROUP BY action
          ORDER BY count DESC
          LIMIT 10
        `).all(cutoff),
        userStats: db.prepare(`
          SELECT users.username, COUNT(*) as count
          FROM audit_log
          LEFT JOIN users ON audit_log.user_id = users.id
          WHERE audit_log.timestamp >= ?
          GROUP BY audit_log.user_id
          ORDER BY count DESC
          LIMIT 10
        `).all(cutoff),
        dailyStats: db.prepare(`
          SELECT
            DATE(timestamp / 1000, 'unixepoch') as date,
            COUNT(*) as count
          FROM audit_log
          WHERE timestamp >= ?
          GROUP BY date
          ORDER BY date DESC
          LIMIT ?
        `).all(cutoff, days),
        totalEvents: (db.prepare(`
          SELECT COUNT(*) as count
          FROM audit_log
          WHERE timestamp >= ?
        `).get(cutoff) as any)?.count || 0
      };
    };

    (DatabaseService as any).cleanupAuditLogs = (days: number) => {
      const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
      const result = db.prepare(`
        DELETE FROM audit_log WHERE timestamp < ?
      `).run(cutoff);
      return result.changes;
    };

    // Add async method mocks for authMiddleware compatibility
    (DatabaseService as any).drizzleDbType = 'sqlite';
    (DatabaseService as any).findUserByIdAsync = async (id: number) => {
      return userModel.findById(id);
    };
    (DatabaseService as any).findUserByUsernameAsync = async (username: string) => {
      return userModel.findByUsername(username);
    };
    (DatabaseService as any).checkPermissionAsync = async (userId: number, resource: string, action: string) => {
      return permissionModel.check(userId, resource, action);
    };
    (DatabaseService as any).getUserPermissionSetAsync = async (userId: number) => {
      return permissionModel.getUserPermissionSet(userId);
    };
    (DatabaseService as any).authenticateAsync = async (username: string, password: string) => {
      return userModel.authenticate(username, password);
    };

    // Add test middleware to inject sessions for testing
    // This must come AFTER session middleware but BEFORE routes
    app.use((req, _res, next) => {
      // Check for test headers to simulate logged-in users
      const testUserId = req.headers['x-test-user-id'];
      if (testUserId) {
        req.session.userId = parseInt(testUserId as string);
        req.session.username = req.headers['x-test-username'] as string || 'testuser';
        req.session.isAdmin = req.headers['x-test-is-admin'] === 'true';
        req.session.authProvider = 'local';
      }
      next();
    });

    app.use('/api/auth', authRoutes);
    app.use('/api/audit', auditRoutes);
  });

  beforeEach(async () => {
    // Clear tables in correct order (audit_log first due to foreign key to users)
    db.prepare('DELETE FROM audit_log').run();
    db.prepare('DELETE FROM permissions').run();
    db.prepare('DELETE FROM users').run();

    // Create admin user
    const admin = await userModel.create({
      username: 'admin',
      password: 'admin123',
      email: 'admin@example.com',
      authProvider: 'local',
      isAdmin: true
    });
    adminUserId = admin.id;
    permissionModel.grantDefaultPermissions(admin.id, true);

    // Create regular user
    const user = await userModel.create({
      username: 'user',
      password: 'user123',
      email: 'user@example.com',
      authProvider: 'local',
      isAdmin: false
    });
    regularUserId = user.id;
    permissionModel.grantDefaultPermissions(user.id, false);

    // Create some test audit log entries
    DatabaseService.auditLog(adminUserId, 'login_success', 'auth', 'Admin logged in', '192.168.1.1');
    DatabaseService.auditLog(adminUserId, 'settings_updated', 'settings', 'Changed theme', '192.168.1.1');
    DatabaseService.auditLog(regularUserId, 'login_success', 'auth', 'User logged in', '192.168.1.2');
    DatabaseService.auditLog(adminUserId, 'api_token_used', 'auth', 'API token access', '192.168.1.3');
  });

  describe('GET /api/audit', () => {
    it('should require authentication', async () => {
      const res = await request(app).get('/api/audit');
      expect(res.status).toBe(401);
    });

    it('should require audit read permission', async () => {
      const res = await asUser().get('/api/audit');
      expect(res.status).toBe(403);
    });

    it('should return audit logs for authorized users', async () => {
      const res = await asAdmin().get('/api/audit');
      expect(res.status).toBe(200);
      expect(res.body.logs).toBeDefined();
      expect(res.body.total).toBeDefined();
      expect(res.body.logs.length).toBeGreaterThan(0);
    });

    it('should filter by userId', async () => {
      const res = await asAdmin().get(`/api/audit?userId=${regularUserId}`);
      expect(res.status).toBe(200);
      expect(res.body.logs).toHaveLength(1);
      expect(res.body.logs[0].user_id).toBe(regularUserId);
    });

    it('should filter by action', async () => {
      const res = await asAdmin().get('/api/audit?action=login_success');
      expect(res.status).toBe(200);
      expect(res.body.logs).toHaveLength(2);
      res.body.logs.forEach((log: any) => {
        expect(log.action).toBe('login_success');
      });
    });

    it('should filter by resource', async () => {
      const res = await asAdmin().get('/api/audit?resource=auth');
      expect(res.status).toBe(200);
      expect(res.body.logs).toHaveLength(3);
    });

    it('should search in details', async () => {
      const res = await asAdmin().get('/api/audit?search=theme');
      expect(res.status).toBe(200);
      expect(res.body.logs).toHaveLength(1);
      expect(res.body.logs[0].details).toContain('theme');
    });

    it('should paginate results', async () => {
      const res = await asAdmin().get('/api/audit?limit=2&offset=0');
      expect(res.status).toBe(200);
      expect(res.body.logs).toHaveLength(2);
      expect(res.body.total).toBe(4);
    });

    it('should filter by date range', async () => {
      const now = Date.now();
      const oneHourAgo = now - (60 * 60 * 1000);

      const res = await asAdmin().get(`/api/audit?startDate=${oneHourAgo}`);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(4);
    });

    it('should filter by excludeAction', async () => {
      const res = await asAdmin().get('/api/audit?excludeAction=api_token_used');
      expect(res.status).toBe(200);
      expect(res.body.logs.every((log: any) => log.action !== 'api_token_used')).toBe(true);
      expect(res.body.total).toBe(3);
    });
  });

  describe('GET /api/audit/:id', () => {
    let logId: number;

    beforeEach(() => {
      const log = db.prepare('SELECT id FROM audit_log LIMIT 1').get() as { id: number };
      logId = log.id;
    });

    it('should require authentication', async () => {
      const res = await request(app).get(`/api/audit/${logId}`);
      expect(res.status).toBe(401);
    });

    it('should require audit read permission', async () => {
      const res = await asUser().get(`/api/audit/${logId}`);
      expect(res.status).toBe(403);
    });

    it('should return specific audit log entry', async () => {
      const res = await asAdmin().get(`/api/audit/${logId}`);
      expect(res.status).toBe(200);
      expect(res.body.log).toBeDefined();
      expect(res.body.log.id).toBe(logId);
    });

    it('should return 404 for non-existent log', async () => {
      const res = await asAdmin().get('/api/audit/99999');
      expect(res.status).toBe(404);
    });

    it('should include username in response', async () => {
      const res = await asAdmin().get(`/api/audit/${logId}`);
      expect(res.status).toBe(200);
      expect(res.body.log.username).toBeDefined();
    });
  });

  describe('GET /api/audit/stats/summary', () => {
    it('should require authentication', async () => {
      const res = await request(app).get('/api/audit/stats/summary');
      expect(res.status).toBe(401);
    });

    it('should require audit read permission', async () => {
      const res = await asUser().get('/api/audit/stats/summary');
      expect(res.status).toBe(403);
    });

    it('should return audit statistics', async () => {
      const res = await asAdmin().get('/api/audit/stats/summary');
      expect(res.status).toBe(200);
      expect(res.body.stats).toBeDefined();
      expect(res.body.stats.actionStats).toBeDefined();
      expect(res.body.stats.userStats).toBeDefined();
      expect(res.body.stats.dailyStats).toBeDefined();
      expect(res.body.stats.totalEvents).toBeDefined();
    });

    it('should accept days parameter', async () => {
      const res = await asAdmin().get('/api/audit/stats/summary?days=7');
      expect(res.status).toBe(200);
      expect(res.body.stats).toBeDefined();
    });

    it('should validate days parameter', async () => {
      const res = await asAdmin().get('/api/audit/stats/summary?days=invalid');
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/audit/cleanup', () => {
    beforeEach(() => {
      // Add old entries
      const oldTimestamp = Date.now() - (100 * 24 * 60 * 60 * 1000);
      db.prepare(`
        INSERT INTO audit_log (user_id, action, resource, details, ip_address, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(adminUserId, 'old_action', 'test', 'Old entry', '192.168.1.1', oldTimestamp);
    });

    it('should require authentication', async () => {
      const res = await request(app).post('/api/audit/cleanup').send({ days: 90 });
      expect(res.status).toBe(401);
    });

    it('should require admin privileges', async () => {
      const res = await asUser().post('/api/audit/cleanup').send({ days: 90 });
      expect(res.status).toBe(403);
    });

    it('should cleanup old audit logs', async () => {
      const beforeResult = db.prepare('SELECT COUNT(*) as count FROM audit_log').get() as any;
      const beforeCount = beforeResult.count;
      expect(beforeCount).toBe(5);

      const res = await asAdmin().post('/api/audit/cleanup').send({ days: 90 });
      expect(res.status).toBe(200);
      expect(res.body.deletedCount).toBe(1);

      // After cleanup: 5 initial - 1 deleted + 1 cleanup audit log = 5
      const afterResult = db.prepare('SELECT COUNT(*) as count FROM audit_log').get() as any;
      const afterCount = afterResult.count;
      expect(afterCount).toBe(5);

      // Verify the old entry was deleted
      const oldEntries = db.prepare(`
        SELECT COUNT(*) as count FROM audit_log
        WHERE action = 'old_action'
      `).get() as any;
      expect(oldEntries.count).toBe(0);

      // Verify cleanup was logged
      const cleanupLogs = db.prepare(`
        SELECT COUNT(*) as count FROM audit_log
        WHERE action = 'audit_cleanup'
      `).get() as any;
      expect(cleanupLogs.count).toBe(1);
    });

    it('should require days parameter', async () => {
      const res = await asAdmin().post('/api/audit/cleanup').send({});
      expect(res.status).toBe(400);
    });

    it('should validate days parameter', async () => {
      const res = await asAdmin().post('/api/audit/cleanup').send({ days: 'invalid' });
      expect(res.status).toBe(400);
    });

    it('should require minimum days value', async () => {
      const res = await asAdmin().post('/api/audit/cleanup').send({ days: 0 });
      expect(res.status).toBe(400);
    });

    it('should log the cleanup action', async () => {
      await asAdmin().post('/api/audit/cleanup').send({ days: 90 });

      const cleanupLog = db.prepare(`
        SELECT * FROM audit_log
        WHERE action = 'audit_cleanup'
        ORDER BY timestamp DESC
        LIMIT 1
      `).get();

      expect(cleanupLog).toBeDefined();
    });
  });

  describe('Permission Enforcement', () => {
    it('should allow users with audit read permission', async () => {
      // Grant audit read permission to regular user
      permissionModel.grant({ userId: regularUserId, resource: 'audit', canRead: true, canWrite: false, grantedBy: adminUserId });

      const res = await asUser().get('/api/audit');
      expect(res.status).toBe(200);
    });

    it('should block users without audit read permission', async () => {
      // Ensure regular user doesn't have audit permission
      db.prepare('DELETE FROM permissions WHERE user_id = ? AND resource = ?').run(regularUserId, 'audit');

      const res = await asUser().get('/api/audit');
      expect(res.status).toBe(403);
    });

    it('should allow admins to cleanup logs', async () => {
      const res = await asAdmin().post('/api/audit/cleanup').send({ days: 90 });
      expect(res.status).toBe(200);
    });

    it('should block non-admins from cleanup even with audit write permission', async () => {
      // Grant audit write permission to regular user
      permissionModel.grant({ userId: regularUserId, resource: 'audit', canRead: true, canWrite: true, grantedBy: adminUserId });

      const res = await asUser().post('/api/audit/cleanup').send({ days: 90 });
      expect(res.status).toBe(403);
    });
  });

  describe('Audit Trail Integrity', () => {
    it('should include IP addresses in audit logs', async () => {
      const res = await asAdmin().get('/api/audit');
      expect(res.status).toBe(200);

      const logsWithIP = res.body.logs.filter((log: any) => log.ip_address);
      expect(logsWithIP.length).toBeGreaterThan(0);
    });

    it('should record user actions with timestamps', async () => {
      const res = await asAdmin().get('/api/audit');
      expect(res.status).toBe(200);

      res.body.logs.forEach((log: any) => {
        expect(log.timestamp).toBeDefined();
        expect(typeof log.timestamp).toBe('number');
      });
    });

    it('should preserve before/after values', async () => {
      // Create an entry with before/after values
      const before = JSON.stringify({ value: 'old' });
      const after = JSON.stringify({ value: 'new' });

      db.prepare(`
        INSERT INTO audit_log (user_id, action, resource, details, ip_address, value_before, value_after, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(adminUserId, 'test_change', 'test', 'Test change', '192.168.1.1', before, after, Date.now());

      const res = await asAdmin().get('/api/audit?action=test_change');
      expect(res.status).toBe(200);
      expect(res.body.logs[0].value_before).toBe(before);
      expect(res.body.logs[0].value_after).toBe(after);
    });
  });
});
