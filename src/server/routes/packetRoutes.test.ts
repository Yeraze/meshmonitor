/**
 * Packet Routes Integration Tests
 *
 * Tests packet logging API endpoints including listing, filtering, stats, and deletion
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import express, { Express } from 'express';
import request from 'supertest';
import { UserModel } from '../models/User.js';
import { PermissionModel } from '../models/Permission.js';
import { migration as authMigration } from '../migrations/001_add_auth_tables.js';
import { migration as channelsMigration } from '../migrations/002_add_channels_permission.js';
import { migration as connectionMigration } from '../migrations/003_add_connection_permission.js';
import { migration as tracerouteMigration } from '../migrations/004_add_traceroute_permission.js';
import { migration as auditMigration } from '../migrations/006_add_audit_permission.js';
import { migration as packetLogMigration } from '../migrations/011_add_packet_log.js';
import { migration as securityPermissionMigration } from '../migrations/016_add_security_permission.js';
import { migration as themesMigration } from '../migrations/022_add_custom_themes.js';
import { migration as passwordLockedMigration } from '../migrations/023_add_password_locked_flag.js';
import { migration as perChannelPermissionsMigration } from '../migrations/024_add_per_channel_permissions.js';
import { migration as nodesPrivatePermissionMigration } from '../migrations/044_add_nodes_private_permission.js';
import { migration as viewOnMapPermissionMigration } from '../migrations/053_add_view_on_map_permission.js';
import { migration as mfaMigration } from '../migrations/068_add_mfa_columns.js';
import { migration as meshcorePermissionMigration } from '../migrations/070_add_meshcore_permission.js';
import packetRoutes from './packetRoutes.js';

// Mock the DatabaseService to prevent auto-initialization
vi.mock('../../services/database.js', () => ({
  default: {}
}));

import DatabaseService from '../../services/database.js';

describe('Packet Routes', () => {
  let app: Express;
  let db: Database.Database;
  let userModel: UserModel;
  let permissionModel: PermissionModel;
  let regularUser: any;
  let adminUser: any;
  let noPermUser: any;

  beforeAll(() => {
    // Setup express app for testing
    app = express();
    app.use(express.json());

    // Setup in-memory database
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');

    // Create settings table (required by packet log migration)
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )
    `);

    // Run migrations
    authMigration.up(db);
    channelsMigration.up(db);
    connectionMigration.up(db);
    tracerouteMigration.up(db);
    auditMigration.up(db);
    packetLogMigration.up(db);
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

    // Mock database service
    (DatabaseService as any).userModel = userModel;
    (DatabaseService as any).permissionModel = permissionModel;
    // Create a spy for auditLog that we can verify in tests
    (DatabaseService as any).auditLog = vi.fn();

    // Mock database methods for packet logging
    (DatabaseService as any).getSetting = (key: string) => {
      const stmt = db.prepare('SELECT value FROM settings WHERE key = ?');
      const result = stmt.get(key) as any;
      return result?.value;
    };

    (DatabaseService as any).setSetting = (key: string, value: string) => {
      const now = Date.now();
      db.prepare(`
        INSERT INTO settings (key, value, createdAt, updatedAt)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = ?, updatedAt = ?
      `).run(key, value, now, now, value, now);
    };

    (DatabaseService as any).insertPacketLog = (packet: any) => {
      const enabled = (DatabaseService as any).getSetting('packet_log_enabled');
      if (enabled !== '1') return 0;

      const stmt = db.prepare(`
        INSERT INTO packet_log (
          packet_id, timestamp, from_node, from_node_id, to_node, to_node_id,
          channel, portnum, portnum_name, encrypted, snr, rssi, hop_limit, hop_start,
          payload_size, want_ack, priority, payload_preview, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const result = stmt.run(
        packet.packet_id, packet.timestamp, packet.from_node, packet.from_node_id,
        packet.to_node, packet.to_node_id, packet.channel, packet.portnum, packet.portnum_name,
        packet.encrypted ? 1 : 0, packet.snr, packet.rssi, packet.hop_limit, packet.hop_start,
        packet.payload_size, packet.want_ack ? 1 : 0, packet.priority, packet.payload_preview,
        packet.metadata
      );

      return result.lastInsertRowid as number;
    };

    (DatabaseService as any).getPacketLogs = (options: any) => {
      let sql = 'SELECT * FROM packet_log WHERE 1=1';
      const params: any[] = [];

      if (options.portnum !== undefined) {
        sql += ' AND portnum = ?';
        params.push(options.portnum);
      }
      if (options.from_node !== undefined) {
        sql += ' AND from_node = ?';
        params.push(options.from_node);
      }
      if (options.to_node !== undefined) {
        sql += ' AND to_node = ?';
        params.push(options.to_node);
      }
      if (options.channel !== undefined) {
        sql += ' AND channel = ?';
        params.push(options.channel);
      }
      if (options.encrypted !== undefined) {
        sql += ' AND encrypted = ?';
        params.push(options.encrypted ? 1 : 0);
      }
      if (options.since !== undefined) {
        sql += ' AND timestamp >= ?';
        params.push(options.since);
      }

      sql += ' ORDER BY timestamp DESC, id DESC';

      if (options.limit !== undefined) {
        sql += ' LIMIT ?';
        params.push(options.limit);
      }
      if (options.offset !== undefined && options.offset > 0) {
        sql += ' OFFSET ?';
        params.push(options.offset);
      }

      return db.prepare(sql).all(...params);
    };

    (DatabaseService as any).getPacketLogById = (id: number) => {
      return db.prepare('SELECT * FROM packet_log WHERE id = ?').get(id) || null;
    };

    (DatabaseService as any).getPacketLogCount = (options: any = {}) => {
      let sql = 'SELECT COUNT(*) as count FROM packet_log WHERE 1=1';
      const params: any[] = [];

      if (options.portnum !== undefined) {
        sql += ' AND portnum = ?';
        params.push(options.portnum);
      }
      if (options.from_node !== undefined) {
        sql += ' AND from_node = ?';
        params.push(options.from_node);
      }
      if (options.to_node !== undefined) {
        sql += ' AND to_node = ?';
        params.push(options.to_node);
      }
      if (options.channel !== undefined) {
        sql += ' AND channel = ?';
        params.push(options.channel);
      }
      if (options.encrypted !== undefined) {
        sql += ' AND encrypted = ?';
        params.push(options.encrypted ? 1 : 0);
      }
      if (options.since !== undefined) {
        sql += ' AND timestamp >= ?';
        params.push(options.since);
      }

      const result = db.prepare(sql).get(...params) as any;
      return result.count;
    };

    // Async versions that wrap the sync methods
    (DatabaseService as any).getPacketLogsAsync = async (options: any) => {
      return (DatabaseService as any).getPacketLogs(options);
    };

    (DatabaseService as any).getPacketLogCountAsync = async (options: any = {}) => {
      return (DatabaseService as any).getPacketLogCount(options);
    };

    (DatabaseService as any).clearPacketLogs = () => {
      const result = db.prepare('DELETE FROM packet_log').run();
      return result.changes;
    };

    (DatabaseService as any).clearPacketLogsAsync = async () => {
      return (DatabaseService as any).clearPacketLogs();
    };

    (DatabaseService as any).cleanupOldPacketLogs = () => {
      const maxAgeHours = (DatabaseService as any).getSetting('packet_log_max_age_hours');
      const hours = maxAgeHours ? parseInt(maxAgeHours, 10) : 24;
      const cutoffTime = Math.floor(Date.now() / 1000) - (hours * 60 * 60);
      const result = db.prepare('DELETE FROM packet_log WHERE timestamp < ?').run(cutoffTime);
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

    // Mock req.user for permission checking
    app.use((req: any, _res, next) => {
      const authHeader = req.headers.authorization;
      if (authHeader === 'Bearer regular') {
        req.user = regularUser;
      } else if (authHeader === 'Bearer admin') {
        req.user = adminUser;
      } else if (authHeader === 'Bearer noperm') {
        req.user = noPermUser;
      }
      next();
    });

    app.use('/api/packets', packetRoutes);
  });

  beforeEach(async () => {
    // Clear tables
    db.prepare('DELETE FROM users').run();
    db.prepare('DELETE FROM permissions').run();
    db.prepare('DELETE FROM packet_log').run();

    // Create test users
    regularUser = await userModel.create({
      username: 'regular',
      password: 'password123',
      email: 'regular@example.com',
      authProvider: 'local',
      isAdmin: false
    });

    adminUser = await userModel.create({
      username: 'admin',
      password: 'admin123',
      email: 'admin@example.com',
      authProvider: 'local',
      isAdmin: true
    });

    noPermUser = await userModel.create({
      username: 'noperm',
      password: 'password123',
      email: 'noperm@example.com',
      authProvider: 'local',
      isAdmin: false
    });

    // Grant permissions
    permissionModel.grant({
      userId: regularUser.id,
      resource: 'channel_0',
      canRead: true,
      canWrite: false
    });
    permissionModel.grant({
      userId: regularUser.id,
      resource: 'messages',
      canRead: true,
      canWrite: false
    });

    // Admin gets all permissions
    permissionModel.grantDefaultPermissions(adminUser.id, true);

    // Enable packet logging and add test data
    (DatabaseService as any).setSetting('packet_log_enabled', '1');
    (DatabaseService as any).setSetting('packet_log_max_count', '1000');
    (DatabaseService as any).setSetting('packet_log_max_age_hours', '24');

    // Add some test packets
    const baseTime = Math.floor(Date.now() / 1000);
    (DatabaseService as any).insertPacketLog({
      packet_id: 1,
      timestamp: baseTime - 100,
      from_node: 111,
      from_node_id: '!000006f',
      to_node: 222,
      to_node_id: '!00000de',
      channel: 0,
      portnum: 1,
      portnum_name: 'TEXT_MESSAGE_APP',
      encrypted: false,
      payload_preview: 'Test message',
      metadata: '{}'
    });

    (DatabaseService as any).insertPacketLog({
      packet_id: 2,
      timestamp: baseTime - 50,
      from_node: 333,
      from_node_id: '!000014d',
      to_node: 4294967295,
      to_node_id: '!ffffffff',
      channel: 1,
      portnum: 3,
      portnum_name: 'POSITION_APP',
      encrypted: true,
      payload_preview: '🔒 <ENCRYPTED>',
      metadata: '{}'
    });
  });

  describe('GET /api/packets', () => {
    it('should return packets for user with permissions', async () => {
      const response = await request(app)
        .get('/api/packets')
        .set('Authorization', 'Bearer regular')
        .expect(200);

      expect(response.body.packets).toBeDefined();
      expect(response.body.packets.length).toBe(2);
      expect(response.body.total).toBe(2);
      expect(response.body.maxCount).toBe(1000);
    });

    it('should deny access without permissions', async () => {
      await request(app)
        .get('/api/packets')
        .set('Authorization', 'Bearer noperm')
        .expect(403);
    });

    it('should filter by portnum', async () => {
      const response = await request(app)
        .get('/api/packets?portnum=1')
        .set('Authorization', 'Bearer regular')
        .expect(200);

      expect(response.body.packets.length).toBe(1);
      expect(response.body.packets[0].portnum).toBe(1);
    });

    it('should filter by encrypted status', async () => {
      const response = await request(app)
        .get('/api/packets?encrypted=true')
        .set('Authorization', 'Bearer regular')
        .expect(200);

      expect(response.body.packets.length).toBe(1);
      expect(response.body.packets[0].encrypted).toBe(1);
    });

    it('should enforce maximum limit', async () => {
      const response = await request(app)
        .get('/api/packets?limit=5000')
        .set('Authorization', 'Bearer regular')
        .expect(200);

      // Limit should be capped at the configured max (defaults to 1000)
      expect(response.body.limit).toBe(1000);
    });

    it('should reject negative offset', async () => {
      await request(app)
        .get('/api/packets?offset=-1')
        .set('Authorization', 'Bearer regular')
        .expect(400);
    });

    it('should reject invalid limit', async () => {
      await request(app)
        .get('/api/packets?limit=0')
        .set('Authorization', 'Bearer regular')
        .expect(400);
    });
  });

  describe('GET /api/packets/stats', () => {
    it('should return packet statistics', async () => {
      const response = await request(app)
        .get('/api/packets/stats')
        .set('Authorization', 'Bearer regular')
        .expect(200);

      expect(response.body.total).toBe(2);
      expect(response.body.encrypted).toBe(1);
      expect(response.body.decoded).toBe(1);
      expect(response.body.maxCount).toBe(1000);
      expect(response.body.maxAgeHours).toBe(24);
      expect(response.body.enabled).toBe(true);
    });

    it('should deny access without permissions', async () => {
      await request(app)
        .get('/api/packets/stats')
        .set('Authorization', 'Bearer noperm')
        .expect(403);
    });
  });

  describe('GET /api/packets/export', () => {
    it('should export packets as JSONL with correct headers', async () => {
      const response = await request(app)
        .get('/api/packets/export')
        .set('Authorization', 'Bearer regular')
        .expect(200);

      expect(response.headers['content-type']).toBe('application/x-ndjson');
      expect(response.headers['content-disposition']).toMatch(/^attachment; filename="packet-monitor-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.jsonl"$/);

      // Parse JSONL response
      const lines = response.text.trim().split('\n');
      expect(lines.length).toBe(2); // Should have 2 packets

      // Verify each line is valid JSON
      lines.forEach(line => {
        const packet = JSON.parse(line);
        expect(packet).toHaveProperty('id');
        expect(packet).toHaveProperty('packet_id');
      });
    });

    it('should export filtered packets', async () => {
      const response = await request(app)
        .get('/api/packets/export?encrypted=true')
        .set('Authorization', 'Bearer regular')
        .expect(200);

      expect(response.headers['content-disposition']).toMatch(/packet-monitor-filtered-/);

      const lines = response.text.trim().split('\n');
      expect(lines.length).toBe(1); // Only 1 encrypted packet
    });

    it('should deny access without permissions', async () => {
      await request(app)
        .get('/api/packets/export')
        .set('Authorization', 'Bearer noperm')
        .expect(403);
    });
  });

  describe('GET /api/packets/:id', () => {
    it('should return single packet by ID', async () => {
      const packets = (DatabaseService as any).getPacketLogs({ limit: 1 });
      const packetId = packets[0].id;

      const response = await request(app)
        .get(`/api/packets/${packetId}`)
        .set('Authorization', 'Bearer regular')
        .expect(200);

      expect(response.body.id).toBe(packetId);
      expect(response.body.packet_id).toBeDefined();
    });

    it('should return 404 for non-existent packet', async () => {
      await request(app)
        .get('/api/packets/999999')
        .set('Authorization', 'Bearer regular')
        .expect(404);
    });

    it('should return 400 for invalid ID', async () => {
      await request(app)
        .get('/api/packets/invalid')
        .set('Authorization', 'Bearer regular')
        .expect(400);
    });

    it('should deny access without permissions', async () => {
      const packets = (DatabaseService as any).getPacketLogs({ limit: 1 });
      const packetId = packets[0].id;

      await request(app)
        .get(`/api/packets/${packetId}`)
        .set('Authorization', 'Bearer noperm')
        .expect(403);
    });
  });

  describe('DELETE /api/packets', () => {
    it('should allow admin to clear packets', async () => {
      const response = await request(app)
        .delete('/api/packets')
        .set('Authorization', 'Bearer admin')
        .expect(200);

      expect(response.body.deletedCount).toBe(2);
      expect(response.body.message).toContain('cleared successfully');

      // Verify packets were deleted
      const packets = (DatabaseService as any).getPacketLogs({ limit: 100 });
      expect(packets.length).toBe(0);
    });

    it('should deny non-admin users', async () => {
      await request(app)
        .delete('/api/packets')
        .set('Authorization', 'Bearer regular')
        .expect(403);
    });

    it('should deny users without permissions', async () => {
      await request(app)
        .delete('/api/packets')
        .set('Authorization', 'Bearer noperm')
        .expect(403);
    });

    it('should create audit log entry when packets are cleared', async () => {
      // Clear any previous calls to auditLog
      vi.clearAllMocks();

      const response = await request(app)
        .delete('/api/packets')
        .set('Authorization', 'Bearer admin')
        .expect(200);

      expect(response.body.deletedCount).toBe(2);

      // Verify audit log was called
      expect(DatabaseService.auditLog).toHaveBeenCalledTimes(1);
      expect(DatabaseService.auditLog).toHaveBeenCalledWith(
        adminUser.id,
        'packets_cleared',
        'packets',
        expect.stringContaining('Cleared 2 packet log entries'),
        expect.anything() // IP address
      );
    });
  });
});
