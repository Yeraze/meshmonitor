/**
 * Audit Log Database Tests
 *
 * Tests audit logging functionality including:
 * - Creating audit log entries
 * - Retrieving audit logs with filtering
 * - Getting audit statistics
 * - Cleaning up old audit logs
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

// Create a test database service with audit functionality
const createTestDatabase = () => {
  const Database = require('better-sqlite3');

  class TestDatabaseService {
    public db: Database.Database;

    constructor() {
      this.db = new Database(':memory:');
      this.db.pragma('foreign_keys = ON');
      this.createTables();
    }

    private createTables(): void {
      // Users table
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS users (
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

      // Audit log table with enhanced columns
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER,
          action TEXT NOT NULL,
          resource TEXT,
          details TEXT,
          ip_address TEXT,
          value_before TEXT,
          value_after TEXT,
          timestamp INTEGER NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id)
        )
      `);

      // Indexes for performance
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id);
        CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
        CREATE INDEX IF NOT EXISTS idx_audit_log_resource ON audit_log(resource);
      `);
    }

    auditLog(
      userId: number | null,
      action: string,
      resource: string | null,
      details: string | null,
      ipAddress: string | null,
      valueBefore?: string | null,
      valueAfter?: string | null
    ): void {
      const stmt = this.db.prepare(`
        INSERT INTO audit_log (user_id, action, resource, details, ip_address, value_before, value_after, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(userId, action, resource, details, ipAddress, valueBefore || null, valueAfter || null, Date.now());
    }

    getAuditLogs(options: {
      limit?: number;
      offset?: number;
      userId?: number;
      action?: string;
      resource?: string;
      startDate?: number;
      endDate?: number;
      search?: string;
    } = {}): { logs: any[]; total: number } {
      const {
        limit = 100,
        offset = 0,
        userId,
        action,
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

      // Get total count
      const countStmt = this.db.prepare(`
        SELECT COUNT(*) as count
        FROM audit_log
        ${whereClause}
      `);
      const { count } = countStmt.get(...params) as { count: number };

      // Get logs
      const logsStmt = this.db.prepare(`
        SELECT
          audit_log.*,
          users.username
        FROM audit_log
        LEFT JOIN users ON audit_log.user_id = users.id
        ${whereClause}
        ORDER BY audit_log.timestamp DESC
        LIMIT ? OFFSET ?
      `);
      const logs = logsStmt.all(...params, limit, offset);

      return { logs, total: count };
    }

    getAuditStats(days: number = 30): any {
      const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);

      // Action statistics
      const actionStats = this.db.prepare(`
        SELECT action, COUNT(*) as count
        FROM audit_log
        WHERE timestamp >= ?
        GROUP BY action
        ORDER BY count DESC
        LIMIT 10
      `).all(cutoff);

      // User statistics
      const userStats = this.db.prepare(`
        SELECT users.username, COUNT(*) as count
        FROM audit_log
        LEFT JOIN users ON audit_log.user_id = users.id
        WHERE audit_log.timestamp >= ?
        GROUP BY audit_log.user_id
        ORDER BY count DESC
        LIMIT 10
      `).all(cutoff);

      // Daily statistics
      const dailyStats = this.db.prepare(`
        SELECT
          DATE(timestamp / 1000, 'unixepoch') as date,
          COUNT(*) as count
        FROM audit_log
        WHERE timestamp >= ?
        GROUP BY date
        ORDER BY date DESC
        LIMIT ?
      `).all(cutoff, days);

      // Total events
      const { totalEvents } = this.db.prepare(`
        SELECT COUNT(*) as totalEvents
        FROM audit_log
        WHERE timestamp >= ?
      `).get(cutoff) as { totalEvents: number };

      return {
        actionStats,
        userStats,
        dailyStats,
        totalEvents
      };
    }

    cleanupAuditLogs(days: number): number {
      const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
      const result = this.db.prepare(`
        DELETE FROM audit_log
        WHERE timestamp < ?
      `).run(cutoff);
      return result.changes;
    }
  }

  return new TestDatabaseService();
};

describe('Audit Log Database Methods', () => {
  let db: any;
  let testUserId: number;

  beforeEach(() => {
    db = createTestDatabase();

    // Create test user
    const result = db.db.prepare(`
      INSERT INTO users (username, email, auth_provider, is_admin, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('testuser', 'test@example.com', 'local', 0, Date.now());
    testUserId = result.lastInsertRowid as number;
  });

  describe('auditLog()', () => {
    it('should create a basic audit log entry', () => {
      db.auditLog(
        testUserId,
        'login_success',
        'auth',
        'User logged in successfully',
        '192.168.1.1'
      );

      const logs = db.db.prepare('SELECT * FROM audit_log').all();
      expect(logs).toHaveLength(1);
      expect(logs[0].user_id).toBe(testUserId);
      expect(logs[0].action).toBe('login_success');
      expect(logs[0].resource).toBe('auth');
      expect(logs[0].details).toBe('User logged in successfully');
      expect(logs[0].ip_address).toBe('192.168.1.1');
    });

    it('should create audit log with before/after values', () => {
      const before = JSON.stringify({ enabled: false });
      const after = JSON.stringify({ enabled: true });

      db.auditLog(
        testUserId,
        'settings_updated',
        'settings',
        'Updated notification settings',
        '192.168.1.1',
        before,
        after
      );

      const logs = db.db.prepare('SELECT * FROM audit_log').all();
      expect(logs).toHaveLength(1);
      expect(logs[0].value_before).toBe(before);
      expect(logs[0].value_after).toBe(after);
    });

    it('should handle null user_id for system actions', () => {
      db.auditLog(
        null,
        'system_startup',
        'system',
        'System started',
        null
      );

      const logs = db.db.prepare('SELECT * FROM audit_log').all();
      expect(logs).toHaveLength(1);
      expect(logs[0].user_id).toBeNull();
    });

    it('should store timestamp', () => {
      const beforeTime = Date.now();
      db.auditLog(testUserId, 'test_action', null, null, null);
      const afterTime = Date.now();

      const logs = db.db.prepare('SELECT * FROM audit_log').all();
      expect(logs[0].timestamp).toBeGreaterThanOrEqual(beforeTime);
      expect(logs[0].timestamp).toBeLessThanOrEqual(afterTime);
    });
  });

  describe('getAuditLogs()', () => {
    beforeEach(() => {
      // Create test data
      db.auditLog(testUserId, 'login_success', 'auth', 'User logged in', '192.168.1.1');
      db.auditLog(testUserId, 'settings_updated', 'settings', 'Changed theme', '192.168.1.1');
      db.auditLog(testUserId, 'logout', 'auth', 'User logged out', '192.168.1.1');

      // Create another user for filtering tests
      const user2Result = db.db.prepare(`
        INSERT INTO users (username, email, auth_provider, is_admin, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run('user2', 'user2@example.com', 'local', 0, Date.now());
      const user2Id = user2Result.lastInsertRowid as number;
      db.auditLog(user2Id, 'login_success', 'auth', 'User 2 logged in', '192.168.1.2');
    });

    it('should return all logs with default options', () => {
      const result = db.getAuditLogs();
      expect(result.logs).toHaveLength(4);
      expect(result.total).toBe(4);
    });

    it('should filter by userId', () => {
      const result = db.getAuditLogs({ userId: testUserId });
      expect(result.logs).toHaveLength(3);
      expect(result.total).toBe(3);
      result.logs.forEach((log: any) => {
        expect(log.user_id).toBe(testUserId);
      });
    });

    it('should filter by action', () => {
      const result = db.getAuditLogs({ action: 'login_success' });
      expect(result.logs).toHaveLength(2);
      expect(result.total).toBe(2);
      result.logs.forEach((log: any) => {
        expect(log.action).toBe('login_success');
      });
    });

    it('should filter by resource', () => {
      const result = db.getAuditLogs({ resource: 'auth' });
      expect(result.logs).toHaveLength(3);
      expect(result.total).toBe(3);
    });

    it('should search in details', () => {
      const result = db.getAuditLogs({ search: 'theme' });
      expect(result.logs).toHaveLength(1);
      expect(result.logs[0].details).toContain('theme');
    });

    it('should paginate results', () => {
      const page1 = db.getAuditLogs({ limit: 2, offset: 0 });
      expect(page1.logs).toHaveLength(2);
      expect(page1.total).toBe(4);

      const page2 = db.getAuditLogs({ limit: 2, offset: 2 });
      expect(page2.logs).toHaveLength(2);
      expect(page2.total).toBe(4);
    });

    it('should filter by date range', () => {
      const now = Date.now();
      const oneHourAgo = now - (60 * 60 * 1000);
      const twoHoursAgo = now - (2 * 60 * 60 * 1000);

      // All logs should be recent
      const recentResult = db.getAuditLogs({ startDate: oneHourAgo });
      expect(recentResult.total).toBe(4);

      // No logs should be from 2 hours ago
      const oldResult = db.getAuditLogs({
        startDate: twoHoursAgo,
        endDate: oneHourAgo
      });
      expect(oldResult.total).toBe(0);
    });

    it('should join with users table for username', () => {
      const result = db.getAuditLogs();
      const logWithUser = result.logs.find((log: any) => log.user_id === testUserId);
      expect(logWithUser.username).toBe('testuser');
    });

    it('should order by timestamp descending', () => {
      const result = db.getAuditLogs();
      for (let i = 0; i < result.logs.length - 1; i++) {
        expect(result.logs[i].timestamp).toBeGreaterThanOrEqual(result.logs[i + 1].timestamp);
      }
    });
  });

  describe('getAuditStats()', () => {
    beforeEach(() => {
      // Create varied test data
      db.auditLog(testUserId, 'login_success', 'auth', 'Login 1', '192.168.1.1');
      db.auditLog(testUserId, 'login_success', 'auth', 'Login 2', '192.168.1.1');
      db.auditLog(testUserId, 'login_success', 'auth', 'Login 3', '192.168.1.1');
      db.auditLog(testUserId, 'settings_updated', 'settings', 'Settings 1', '192.168.1.1');
      db.auditLog(testUserId, 'settings_updated', 'settings', 'Settings 2', '192.168.1.1');
      db.auditLog(testUserId, 'logout', 'auth', 'Logout', '192.168.1.1');
    });

    it('should return action statistics', () => {
      const stats = db.getAuditStats();
      expect(stats.actionStats).toBeDefined();
      expect(stats.actionStats.length).toBeGreaterThan(0);

      const loginStats = stats.actionStats.find((s: any) => s.action === 'login_success');
      expect(loginStats.count).toBe(3);
    });

    it('should return user statistics', () => {
      const stats = db.getAuditStats();
      expect(stats.userStats).toBeDefined();
      expect(stats.userStats.length).toBeGreaterThan(0);

      const userStat = stats.userStats.find((s: any) => s.username === 'testuser');
      expect(userStat.count).toBe(6);
    });

    it('should return daily statistics', () => {
      const stats = db.getAuditStats();
      expect(stats.dailyStats).toBeDefined();
      expect(stats.dailyStats.length).toBeGreaterThan(0);
    });

    it('should return total events count', () => {
      const stats = db.getAuditStats();
      expect(stats.totalEvents).toBe(6);
    });

    it('should filter by days parameter', () => {
      const stats = db.getAuditStats(30);
      expect(stats.totalEvents).toBe(6);

      // Add an old entry
      const oldTimestamp = Date.now() - (60 * 24 * 60 * 60 * 1000); // 60 days ago
      db.db.prepare(`
        INSERT INTO audit_log (user_id, action, resource, details, ip_address, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(testUserId, 'old_action', 'test', 'Old entry', '192.168.1.1', oldTimestamp);

      const stats30 = db.getAuditStats(30);
      expect(stats30.totalEvents).toBe(6); // Should not include 60-day-old entry

      const stats90 = db.getAuditStats(90);
      expect(stats90.totalEvents).toBe(7); // Should include 60-day-old entry
    });
  });

  describe('cleanupAuditLogs()', () => {
    beforeEach(() => {
      // Create recent entries
      db.auditLog(testUserId, 'recent1', 'test', 'Recent 1', '192.168.1.1');
      db.auditLog(testUserId, 'recent2', 'test', 'Recent 2', '192.168.1.1');

      // Create old entries
      const oldTimestamp = Date.now() - (100 * 24 * 60 * 60 * 1000); // 100 days ago
      db.db.prepare(`
        INSERT INTO audit_log (user_id, action, resource, details, ip_address, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(testUserId, 'old1', 'test', 'Old 1', '192.168.1.1', oldTimestamp);
      db.db.prepare(`
        INSERT INTO audit_log (user_id, action, resource, details, ip_address, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(testUserId, 'old2', 'test', 'Old 2', '192.168.1.1', oldTimestamp);
    });

    it('should delete logs older than specified days', () => {
      const beforeCount = db.db.prepare('SELECT COUNT(*) as count FROM audit_log').get().count;
      expect(beforeCount).toBe(4);

      const deleted = db.cleanupAuditLogs(90);
      expect(deleted).toBe(2);

      const afterCount = db.db.prepare('SELECT COUNT(*) as count FROM audit_log').get().count;
      expect(afterCount).toBe(2);
    });

    it('should keep recent logs', () => {
      db.cleanupAuditLogs(90);

      const recentLogs = db.db.prepare('SELECT * FROM audit_log').all();
      expect(recentLogs).toHaveLength(2);
      recentLogs.forEach((log: any) => {
        expect(log.action).toMatch(/^recent/);
      });
    });

    it('should return number of deleted entries', () => {
      const deleted = db.cleanupAuditLogs(90);
      expect(deleted).toBe(2);
    });

    it('should handle zero deletions', () => {
      const deleted = db.cleanupAuditLogs(200); // All logs are newer than 200 days
      expect(deleted).toBe(0);
    });
  });
});
