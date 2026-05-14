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
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../db/schema/index.js';
import express, { Express } from 'express';
import session from 'express-session';
import request from 'supertest';

import { AuthRepository } from '../../db/repositories/auth.js';
import { PermissionTestHelper } from '../test-helpers/permissionTestHelper.js';
import { UserTestHelper } from '../test-helpers/userTestHelper.js';
import { migration as baselineMigration } from '../migrations/001_v37_baseline.js';
import { migration as sourceIdPermsMigration } from '../migrations/022_add_source_id_to_permissions.js';

// Mock dependencies before importing routes
vi.mock('../../services/database.js', () => ({
  default: {}
}));

// Stub manager — every method the routes call is mocked. The MeshCore
// multi-source refactor put the manager behind a per-source registry; we
// mock the registry directly here so requests under
// `/api/sources/test-source/meshcore/*` resolve to this stub.
const meshcoreManager = {
  // The /info route reads `manager.sourceId` to populate telemetryRef.
  sourceId: 'test-source',
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
  isConnected: vi.fn().mockReturnValue(false),
};

vi.mock('../meshcoreManager.js', () => ({
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
  MeshCoreManager: class {},
}));

// Only `test-source` is registered; unknown ids return undefined so the
// router-level guard returns 404.
const REGISTERED_SOURCE_IDS = new Set(['test-source']);
vi.mock('../meshcoreRegistry.js', () => ({
  meshcoreManagerRegistry: {
    getOrCreateLegacyManager: () => meshcoreManager,
    list: () => [meshcoreManager],
    get: (sourceId: string) => (REGISTERED_SOURCE_IDS.has(sourceId) ? meshcoreManager : undefined),
  },
  LEGACY_MESHCORE_SOURCE_ID: 'meshcore-legacy-default',
}));

// The `/info` route reads the last poll snapshot from the singleton poller.
// We expose a mutable fake here so individual tests can decide whether to
// return a snapshot, returning null otherwise.
const fakePollerSnapshot: { value: any } = { value: null };
vi.mock('../services/meshcoreTelemetryPoller.js', () => ({
  getMeshCoreTelemetryPoller: () => ({
    getLastSnapshot: () => fakePollerSnapshot.value,
  }),
  // The route also imports `nodeNumFromPubkey` to build telemetryRef.
  nodeNumFromPubkey: (publicKey: string) => {
    if (!publicKey) return 0;
    const tail = publicKey.replace(/^0x/, '').slice(-8);
    const n = parseInt(tail, 16);
    return Number.isFinite(n) ? n & 0x7fffffff : 0;
  },
}));

import DatabaseService from '../../services/database.js';
import meshcoreRoutes from './meshcoreRoutes.js';
import authRoutes from './authRoutes.js';

describe('MeshCore Routes', () => {
  let app: Express;
  let db: Database.Database;
  let userModel: UserTestHelper;
  let permissionModel: PermissionTestHelper;
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
    // Run baseline migration (creates all tables)
    baselineMigration.up(db);
    // Add sourceId column to permissions (migration 022)
    sourceIdPermsMigration.up(db);

    const drizzleDb = drizzle(db, { schema });
    const authRepo = new AuthRepository(drizzleDb, 'sqlite');
    userModel = new UserTestHelper(authRepo);
    permissionModel = new PermissionTestHelper(authRepo);

    // Mock database service
    // permissionModel wired via checkPermissionAsync / getUserPermissionSetAsync below
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
      return permissionModel.check(userId, resource as any, action as any);
    };
    (DatabaseService as any).authenticateAsync = async (username: string, password: string) => {
      return userModel.authenticate(username, password);
    };
    (DatabaseService as any).getUserPermissionSetAsync = async (userId: number) => {
      return permissionModel.getUserPermissionSet(userId);
    };

    // Create anonymous user with read permissions on the sourcey resources
    // the MeshCore routes check (slice 3 collapsed the global `meshcore`
    // resource into per-source connection/nodes/messages/configuration).
    const anonymousUser = await userModel.create({
      username: 'anonymous',
      password: 'anonymous123',
      authProvider: 'local',
    });
    for (const resource of ['connection', 'nodes', 'messages', 'configuration'] as const) {
      await permissionModel.grant({
        userId: anonymousUser.id,
        resource,
        canRead: true,
        canWrite: false,
      });
    }

    // Mount routes. Slice 3 dropped the un-nested `/api/meshcore` mount,
    // so the tests below all hit `/api/sources/test-source/meshcore/*`.
    app.use('/api/auth', authRoutes);
    app.use('/api/sources/:id/meshcore', meshcoreRoutes);
  });

  let testUserCounter = 0;

  beforeEach(async () => {
    // Create unique test user for each test
    testUserCounter++;
    const username = `testuser${testUserCounter}`;

    const user = await userModel.create({
      username,
      password: 'password123',
      authProvider: 'local'
    });

    for (const resource of ['connection', 'nodes', 'messages', 'configuration'] as const) {
      await permissionModel.grant({
        userId: user.id,
        resource,
        canRead: true,
        canWrite: true,
      });
    }

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

  describe('GET /api/sources/test-source/meshcore/status', () => {
    it('should return status without authentication', async () => {
      const response = await request(app).get('/api/sources/test-source/meshcore/status');
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe('Nested mount /api/sources/:id/meshcore', () => {
    it('resolves the manager via :id and serves status', async () => {
      const response = await request(app).get('/api/sources/test-source/meshcore/status');
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('returns 404 when :id has no registered manager', async () => {
      const response = await request(app).get('/api/sources/does-not-exist/meshcore/status');
      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/does-not-exist/);
    });
  });

  describe('POST /api/sources/test-source/meshcore/connect', () => {
    it('should require authentication', async () => {
      const response = await request(app)
        .post('/api/sources/test-source/meshcore/connect')
        .send({ connectionType: 'serial', serialPort: 'COM3' });
      expect(response.status).toBe(401);
    });

    it('should connect with valid parameters', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/connect')
        .send({ connectionType: 'serial', serialPort: 'COM3' });
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should reject invalid connection type', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/connect')
        .send({ connectionType: 'invalid', serialPort: 'COM3' });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Connection type');
    });

    it('should reject invalid baud rate', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/connect')
        .send({ connectionType: 'serial', serialPort: 'COM3', baudRate: 12345 });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Baud rate');
    });

    it('should reject invalid TCP port', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/connect')
        .send({ connectionType: 'tcp', tcpHost: '192.168.1.1', tcpPort: 70000 });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('port');
    });
  });

  describe('POST /api/sources/test-source/meshcore/messages/send', () => {
    it('should require authentication', async () => {
      const response = await request(app)
        .post('/api/sources/test-source/meshcore/messages/send')
        .send({ text: 'Hello' });
      expect(response.status).toBe(401);
    });

    it('should send message with valid text', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/messages/send')
        .send({ text: 'Hello world' });
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should reject empty message', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/messages/send')
        .send({ text: '' });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Message');
    });

    it('should reject message exceeding max length', async () => {
      const longMessage = 'a'.repeat(300);
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/messages/send')
        .send({ text: longMessage });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('maximum length');
    });

    it('should reject invalid public key format', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/messages/send')
        .send({ text: 'Hello', toPublicKey: 'invalid-key' });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('public key');
    });

    it('should accept valid public key', async () => {
      const validKey = 'a'.repeat(64);
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/messages/send')
        .send({ text: 'Hello', toPublicKey: validKey });
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe('POST /api/sources/test-source/meshcore/admin/login', () => {
    it('should require authentication', async () => {
      const response = await request(app)
        .post('/api/sources/test-source/meshcore/admin/login')
        .send({ publicKey: 'a'.repeat(64), password: 'admin' });
      expect(response.status).toBe(401);
    });

    it('should reject invalid public key format', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/admin/login')
        .send({ publicKey: 'invalid', password: 'admin' });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('public key');
    });

    it('should accept valid login request', async () => {
      const validKey = 'a'.repeat(64);
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/admin/login')
        .send({ publicKey: validKey, password: 'admin123' });
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe('GET /api/sources/test-source/meshcore/admin/status/:publicKey', () => {
    it('should reject invalid public key format', async () => {
      const response = await authenticatedAgent
        .get('/api/sources/test-source/meshcore/admin/status/invalid-key');
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('public key');
    });

    it('should accept valid public key', async () => {
      const validKey = 'a'.repeat(64);
      const response = await authenticatedAgent
        .get(`/api/sources/test-source/meshcore/admin/status/${validKey}`);
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe('POST /api/sources/test-source/meshcore/config/name', () => {
    it('should require authentication', async () => {
      const response = await request(app)
        .post('/api/sources/test-source/meshcore/config/name')
        .send({ name: 'TestNode' });
      expect(response.status).toBe(401);
    });

    it('should reject empty name', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/config/name')
        .send({ name: '' });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Name');
    });

    it('should reject whitespace-only name', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/config/name')
        .send({ name: '   ' });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('empty');
    });

    it('should reject name exceeding max length', async () => {
      const longName = 'a'.repeat(50);
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/config/name')
        .send({ name: longName });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('maximum length');
    });

    it('should accept valid name', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/config/name')
        .send({ name: 'MyNode' });
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe('POST /api/sources/test-source/meshcore/config/radio', () => {
    it('should require authentication', async () => {
      const response = await request(app)
        .post('/api/sources/test-source/meshcore/config/radio')
        .send({ freq: 915.0, bw: 125, sf: 7, cr: 5 });
      expect(response.status).toBe(401);
    });

    it('should reject missing parameters', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/config/radio')
        .send({ freq: 915.0 });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('required');
    });

    it('should reject frequency out of range', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/config/radio')
        .send({ freq: 2000.0, bw: 125, sf: 7, cr: 5 });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Frequency');
    });

    it('should reject invalid bandwidth', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/config/radio')
        .send({ freq: 915.0, bw: 100, sf: 7, cr: 5 });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Bandwidth');
    });

    it('should reject spreading factor out of range', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/config/radio')
        .send({ freq: 915.0, bw: 125, sf: 15, cr: 5 });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Spreading factor');
    });

    it('should reject coding rate out of range', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/config/radio')
        .send({ freq: 915.0, bw: 125, sf: 7, cr: 10 });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Coding rate');
    });

    it('should accept valid radio parameters', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/config/radio')
        .send({ freq: 915.0, bw: 125, sf: 7, cr: 5 });
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe('GET /api/sources/test-source/meshcore/messages', () => {
    it('should return messages without authentication', async () => {
      const response = await request(app).get('/api/sources/test-source/meshcore/messages');
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('should limit messages to max allowed', async () => {
      const response = await request(app).get('/api/sources/test-source/meshcore/messages?limit=5000');
      expect(response.status).toBe(200);
      // Should clamp to max limit (1000) without error
      expect(meshcoreManager.getRecentMessages).toHaveBeenCalledWith(1000);
    });
  });

  describe('GET /api/sources/test-source/meshcore/info', () => {
    const FULL_PUBKEY = 'a'.repeat(64);

    beforeEach(() => {
      fakePollerSnapshot.value = null;
    });

    it('returns 404 when the source is not registered', async () => {
      const response = await request(app).get('/api/sources/no-such-source/meshcore/info');
      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
    });

    it('returns identity + null latest when no poll has fired yet', async () => {
      meshcoreManager.getConnectionStatus.mockReturnValueOnce({
        connected: true,
        deviceType: 1, // Companion
        config: null,
      });
      meshcoreManager.getLocalNode.mockReturnValueOnce({
        publicKey: FULL_PUBKEY,
        name: 'TestNode',
        advType: 1,
        radioFreq: 915.0,
        radioBw: 125,
        radioSf: 7,
        radioCr: 5,
      });

      const response = await request(app).get('/api/sources/test-source/meshcore/info');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.connected).toBe(true);
      expect(response.body.data.deviceType).toBe(1);
      expect(response.body.data.identity).toMatchObject({
        publicKey: FULL_PUBKEY,
        name: 'TestNode',
        radioFreq: 915.0,
      });
      expect(response.body.data.latest).toBeNull();
      expect(response.body.data.telemetryRef).toEqual({
        nodeId: FULL_PUBKEY,
        nodeNum: expect.any(Number),
        sourceId: 'test-source',
      });
    });

    it('returns the latest poll snapshot when the poller has run', async () => {
      meshcoreManager.getConnectionStatus.mockReturnValueOnce({
        connected: true,
        deviceType: 1,
        config: null,
      });
      meshcoreManager.getLocalNode.mockReturnValueOnce({
        publicKey: FULL_PUBKEY,
        name: 'TestNode',
        advType: 1,
      });
      fakePollerSnapshot.value = {
        timestamp: 1700000000000,
        batteryMv: 4100,
        uptimeSecs: 7200,
        queueLen: 1,
        lastRssi: -88,
        lastSnr: 6.5,
        rtcDriftSecs: -2,
        deviceInfo: { firmwareVer: 9, firmwareBuild: '2024-11-01', model: 'Heltec V3' },
      };

      const response = await request(app).get('/api/sources/test-source/meshcore/info');

      expect(response.status).toBe(200);
      expect(response.body.data.latest).toEqual(fakePollerSnapshot.value);
    });

    it('returns null telemetryRef when no localNode has been resolved', async () => {
      meshcoreManager.getConnectionStatus.mockReturnValueOnce({
        connected: false,
        deviceType: 0,
        config: null,
      });
      meshcoreManager.getLocalNode.mockReturnValueOnce(null);

      const response = await request(app).get('/api/sources/test-source/meshcore/info');

      expect(response.status).toBe(200);
      expect(response.body.data.identity).toBeNull();
      expect(response.body.data.telemetryRef).toBeNull();
    });
  });
});
