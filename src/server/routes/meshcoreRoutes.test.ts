/**
 * MeshCore Routes Tests
 *
 * Tests for MeshCore API endpoints including:
 * - Input validation
 * - Rate limiting
 * - Authentication requirements
 */

import { describe, it, expect, beforeEach, beforeAll, vi, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import express, { Express } from 'express';
import session from 'express-session';
import request from 'supertest';
import { UserModel } from '../models/User.js';
import { PermissionModel } from '../models/Permission.js';
import { migration as authMigration } from '../migrations/001_add_auth_tables.js';
import { migration as channelsMigration } from '../migrations/002_add_channels_permission.js';
import { migration as connectionMigration } from '../migrations/003_add_connection_permission.js';
import { migration as tracerouteMigration } from '../migrations/004_add_traceroute_permission.js';
import { migration as auditPermissionMigration } from '../migrations/006_add_audit_permission.js';
import { migration as securityPermissionMigration } from '../migrations/016_add_security_permission.js';
import { migration as themesMigration } from '../migrations/022_add_custom_themes.js';
import { migration as passwordLockedMigration } from '../migrations/023_add_password_locked_flag.js';
import { migration as perChannelPermissionsMigration } from '../migrations/024_add_per_channel_permissions.js';
import { migration as nodesPrivatePermissionMigration } from '../migrations/044_add_nodes_private_permission.js';
import { migration as viewOnMapPermissionMigration } from '../migrations/053_add_view_on_map_permission.js';
import { migration as mfaMigration } from '../migrations/068_add_mfa_columns.js';
import { migration as meshcorePermissionMigration } from '../migrations/071_add_meshcore_permission.js';

// Mock dependencies before importing routes
vi.mock('../../services/database.js', () => ({
  default: {}
}));

vi.mock('../meshcoreManager.js', () => ({
  default: {
    getConnectionStatus: vi.fn().mockReturnValue({
      connected: false,
      deviceType: 0,
      config: null,
    }),
    getLocalNode: vi.fn().mockReturnValue(null),
    getEnvConfig: vi.fn().mockReturnValue(null),
    getAllNodes: vi.fn().mockReturnValue([]),
    getContacts: vi.fn().mockReturnValue([]),
    getRecentMessages: vi.fn().mockReturnValue([]),
    connect: vi.fn().mockResolvedValue(true),
    disconnect: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(true),
    sendAdvert: vi.fn().mockResolvedValue(true),
    refreshContacts: vi.fn().mockResolvedValue(new Map()),
    loginToNode: vi.fn().mockResolvedValue(true),
    requestNodeStatus: vi.fn().mockResolvedValue({ batteryMv: 4200, uptimeSecs: 3600 }),
    setName: vi.fn().mockResolvedValue(true),
    setRadio: vi.fn().mockResolvedValue(true),
  },
  ConnectionType: {
    SERIAL: 'serial',
    TCP: 'tcp',
  },
  MeshCoreDeviceType: {
    0: 'Unknown',
    1: 'Companion',
    2: 'Repeater',
    3: 'RoomServer',
  },
}));

import DatabaseService from '../../services/database.js';
import meshcoreRoutes from './meshcoreRoutes.js';
import authRoutes from './authRoutes.js';
import meshcoreManager from '../meshcoreManager.js';

describe('MeshCore Routes', () => {
  let app: Express;
  let db: Database.Database;
  let userModel: UserModel;
  let permissionModel: PermissionModel;
  let authenticatedAgent: any;

  beforeAll(async () => {
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
    authMigration.up(db);
    channelsMigration.up(db);
    connectionMigration.up(db);
    tracerouteMigration.up(db);
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

    // Mock database service
    (DatabaseService as any).userModel = userModel;
    (DatabaseService as any).permissionModel = permissionModel;
    (DatabaseService as any).auditLog = () => {};
    (DatabaseService as any).drizzleDbType = 'sqlite';

    // Add async method mocks
    (DatabaseService as any).findUserByIdAsync = async (id: number) => {
      return userModel.findById(id);
    };
    (DatabaseService as any).findUserByUsernameAsync = async (username: string) => {
      return userModel.findByUsername(username);
    };
    (DatabaseService as any).checkPermissionAsync = async (userId: number, resource: string, action: string) => {
      return permissionModel.check(userId, resource, action);
    };
    (DatabaseService as any).authenticateAsync = async (username: string, password: string) => {
      return userModel.authenticate(username, password);
    };
    (DatabaseService as any).getUserPermissionSetAsync = async (userId: number) => {
      return permissionModel.getUserPermissionSet(userId);
    };

    // Create anonymous user with meshcore read permission for unauthenticated access
    const anonymousUser = await userModel.create({
      username: 'anonymous',
      password: 'anonymous123',
      authProvider: 'local',
    });
    permissionModel.grant({
      userId: anonymousUser.id,
      resource: 'meshcore',
      canRead: true,
      canWrite: false,
    });

    // Mount routes
    app.use('/api/auth', authRoutes);
    app.use('/api/meshcore', meshcoreRoutes);
  });

  let testUserCounter = 0;
  let testUserId: number;

  beforeEach(async () => {
    // Create unique test user for each test
    testUserCounter++;
    const username = `testuser${testUserCounter}`;

    const user = await userModel.create({
      username,
      password: 'password123',
      authProvider: 'local'
    });
    testUserId = user.id;

    permissionModel.grant({
      userId: user.id,
      resource: 'meshcore',
      canRead: true,
      canWrite: true
    });

    // Login
    authenticatedAgent = request.agent(app);
    await authenticatedAgent
      .post('/api/auth/login')
      .send({ username, password: 'password123' });

    // Reset mocks
    vi.clearAllMocks();
  });

  afterAll(() => {
    db.close();
  });

  describe('GET /api/meshcore/status', () => {
    it('should return status without authentication', async () => {
      const response = await request(app).get('/api/meshcore/status');
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe('POST /api/meshcore/connect', () => {
    it('should require authentication', async () => {
      const response = await request(app)
        .post('/api/meshcore/connect')
        .send({ connectionType: 'serial', serialPort: 'COM3' });
      expect(response.status).toBe(401);
    });

    it('should connect with valid parameters', async () => {
      const response = await authenticatedAgent
        .post('/api/meshcore/connect')
        .send({ connectionType: 'serial', serialPort: 'COM3' });
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should reject invalid connection type', async () => {
      const response = await authenticatedAgent
        .post('/api/meshcore/connect')
        .send({ connectionType: 'invalid', serialPort: 'COM3' });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Connection type');
    });

    it('should reject invalid baud rate', async () => {
      const response = await authenticatedAgent
        .post('/api/meshcore/connect')
        .send({ connectionType: 'serial', serialPort: 'COM3', baudRate: 12345 });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Baud rate');
    });

    it('should reject invalid TCP port', async () => {
      const response = await authenticatedAgent
        .post('/api/meshcore/connect')
        .send({ connectionType: 'tcp', tcpHost: '192.168.1.1', tcpPort: 70000 });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('port');
    });
  });

  describe('POST /api/meshcore/messages/send', () => {
    it('should require authentication', async () => {
      const response = await request(app)
        .post('/api/meshcore/messages/send')
        .send({ text: 'Hello' });
      expect(response.status).toBe(401);
    });

    it('should send message with valid text', async () => {
      const response = await authenticatedAgent
        .post('/api/meshcore/messages/send')
        .send({ text: 'Hello world' });
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should reject empty message', async () => {
      const response = await authenticatedAgent
        .post('/api/meshcore/messages/send')
        .send({ text: '' });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Message');
    });

    it('should reject message exceeding max length', async () => {
      const longMessage = 'a'.repeat(300);
      const response = await authenticatedAgent
        .post('/api/meshcore/messages/send')
        .send({ text: longMessage });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('maximum length');
    });

    it('should reject invalid public key format', async () => {
      const response = await authenticatedAgent
        .post('/api/meshcore/messages/send')
        .send({ text: 'Hello', toPublicKey: 'invalid-key' });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('public key');
    });

    it('should accept valid public key', async () => {
      const validKey = 'a'.repeat(64);
      const response = await authenticatedAgent
        .post('/api/meshcore/messages/send')
        .send({ text: 'Hello', toPublicKey: validKey });
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe('POST /api/meshcore/admin/login', () => {
    it('should require authentication', async () => {
      const response = await request(app)
        .post('/api/meshcore/admin/login')
        .send({ publicKey: 'a'.repeat(64), password: 'admin' });
      expect(response.status).toBe(401);
    });

    it('should reject invalid public key format', async () => {
      const response = await authenticatedAgent
        .post('/api/meshcore/admin/login')
        .send({ publicKey: 'invalid', password: 'admin' });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('public key');
    });

    it('should accept valid login request', async () => {
      const validKey = 'a'.repeat(64);
      const response = await authenticatedAgent
        .post('/api/meshcore/admin/login')
        .send({ publicKey: validKey, password: 'admin123' });
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe('GET /api/meshcore/admin/status/:publicKey', () => {
    it('should reject invalid public key format', async () => {
      const response = await authenticatedAgent
        .get('/api/meshcore/admin/status/invalid-key');
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('public key');
    });

    it('should accept valid public key', async () => {
      const validKey = 'a'.repeat(64);
      const response = await authenticatedAgent
        .get(`/api/meshcore/admin/status/${validKey}`);
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe('POST /api/meshcore/config/name', () => {
    it('should require authentication', async () => {
      const response = await request(app)
        .post('/api/meshcore/config/name')
        .send({ name: 'TestNode' });
      expect(response.status).toBe(401);
    });

    it('should reject empty name', async () => {
      const response = await authenticatedAgent
        .post('/api/meshcore/config/name')
        .send({ name: '' });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Name');
    });

    it('should reject whitespace-only name', async () => {
      const response = await authenticatedAgent
        .post('/api/meshcore/config/name')
        .send({ name: '   ' });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('empty');
    });

    it('should reject name exceeding max length', async () => {
      const longName = 'a'.repeat(50);
      const response = await authenticatedAgent
        .post('/api/meshcore/config/name')
        .send({ name: longName });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('maximum length');
    });

    it('should accept valid name', async () => {
      const response = await authenticatedAgent
        .post('/api/meshcore/config/name')
        .send({ name: 'MyNode' });
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe('POST /api/meshcore/config/radio', () => {
    it('should require authentication', async () => {
      const response = await request(app)
        .post('/api/meshcore/config/radio')
        .send({ freq: 915.0, bw: 125, sf: 7, cr: 5 });
      expect(response.status).toBe(401);
    });

    it('should reject missing parameters', async () => {
      const response = await authenticatedAgent
        .post('/api/meshcore/config/radio')
        .send({ freq: 915.0 });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('required');
    });

    it('should reject frequency out of range', async () => {
      const response = await authenticatedAgent
        .post('/api/meshcore/config/radio')
        .send({ freq: 2000.0, bw: 125, sf: 7, cr: 5 });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Frequency');
    });

    it('should reject invalid bandwidth', async () => {
      const response = await authenticatedAgent
        .post('/api/meshcore/config/radio')
        .send({ freq: 915.0, bw: 100, sf: 7, cr: 5 });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Bandwidth');
    });

    it('should reject spreading factor out of range', async () => {
      const response = await authenticatedAgent
        .post('/api/meshcore/config/radio')
        .send({ freq: 915.0, bw: 125, sf: 15, cr: 5 });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Spreading factor');
    });

    it('should reject coding rate out of range', async () => {
      const response = await authenticatedAgent
        .post('/api/meshcore/config/radio')
        .send({ freq: 915.0, bw: 125, sf: 7, cr: 10 });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Coding rate');
    });

    it('should accept valid radio parameters', async () => {
      const response = await authenticatedAgent
        .post('/api/meshcore/config/radio')
        .send({ freq: 915.0, bw: 125, sf: 7, cr: 5 });
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe('GET /api/meshcore/messages', () => {
    it('should return messages without authentication', async () => {
      const response = await request(app).get('/api/meshcore/messages');
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('should limit messages to max allowed', async () => {
      const response = await request(app).get('/api/meshcore/messages?limit=5000');
      expect(response.status).toBe(200);
      // Should clamp to max limit (1000) without error
      expect(meshcoreManager.getRecentMessages).toHaveBeenCalledWith(1000);
    });
  });
});
