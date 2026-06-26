/**
 * MeshCore Routes Tests
 *
 * Tests for MeshCore API endpoints including:
 * - Input validation
 * - Rate limiting
 * - Authentication requirements
 */

import { describe, it, expect, beforeEach, beforeAll, vi, afterAll, afterEach } from 'vitest';
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
  getAllNodes: vi.fn().mockReturnValue([]),
  getContacts: vi.fn().mockReturnValue([]),
  getContact: vi.fn().mockReturnValue(undefined),
  getRecentMessages: vi.fn().mockReturnValue([]),
  connect: vi.fn().mockResolvedValue(true),
  disconnect: vi.fn().mockResolvedValue(undefined),
  sendMessage: vi.fn().mockResolvedValue(true),
  sendAdvert: vi.fn().mockResolvedValue(true),
  refreshContacts: vi.fn().mockResolvedValue(new Map()),
  removeContact: vi.fn().mockResolvedValue(true),
  forgetLocalContact: vi.fn().mockResolvedValue(true),
  resetContactPath: vi.fn().mockResolvedValue(true),
  discoverContactPath: vi.fn().mockResolvedValue(true),
  discoverNodes: vi.fn().mockResolvedValue({ returned: 0, newCount: 0 }),
  getRespondToDiscovery: vi.fn().mockResolvedValue(false),
  setRespondToDiscovery: vi.fn().mockResolvedValue(undefined),
  shareContact: vi.fn().mockResolvedValue({ ok: true }),
  setContactOutPath: vi.fn().mockResolvedValue(true),
  setNodeFavorite: vi.fn().mockResolvedValue(undefined),
  loginToNode: vi.fn().mockResolvedValue(true),
  requestNodeStatus: vi.fn().mockResolvedValue({ batteryMv: 4200, uptimeSecs: 3600 }),
  sendCliCommand: vi.fn().mockResolvedValue({ reply: 'ok', elapsedMs: 42 }),
  sendLocalCliCommand: vi.fn().mockResolvedValue({ reply: 'v1.7.0', elapsedMs: 12 }),
  setName: vi.fn().mockResolvedValue(true),
  setRadio: vi.fn().mockResolvedValue(true),
  syncDeviceTime: vi.fn().mockResolvedValue({ ok: true }),
  importPrivateKey: vi.fn().mockResolvedValue(true),
  exportPrivateKey: vi.fn().mockResolvedValue('a'.repeat(128)),
  isConnected: vi.fn().mockReturnValue(false),
  // Mesh-TX throttle primitives read by the manual telemetry-poll route.
  getLastMeshTxAt: vi.fn().mockReturnValue(0),
  recordMeshTx: vi.fn(),
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
  MeshCoreDiscoverFilter: {
    NEARBY: 0x1e,
    REPEATERS: 0x0c,
    SENSORS: 0x10,
  },
  MeshCoreManager: class {},
}));

// Only `test-source` is registered; unknown ids return undefined so the
// router-level guard returns 404.
const REGISTERED_SOURCE_IDS = new Set(['test-source']);
vi.mock('../meshcoreRegistry.js', () => ({
  meshcoreManagerRegistry: {
    list: () => [meshcoreManager],
    get: (sourceId: string) => (REGISTERED_SOURCE_IDS.has(sourceId) ? meshcoreManager : undefined),
  },
}));

// Fake credential store with controllable capability + storage. Tests can
// toggle `canRemember` and inspect calls to `store`/`clear`.
const fakeCredentialStore = {
  capability: { canRemember: true as boolean, reason: undefined as string | undefined },
  store: vi.fn(async (_sid: string, _pk: string, _pw: string) => undefined),
  load: vi.fn(
    async () =>
      ({ kind: 'none' as const }) as
        | { kind: 'none' }
        | { kind: 'ok'; password: string }
        | { kind: 'key_rotated'; storedKid: string },
  ),
  clear: vi.fn(async (_sid: string, _pk: string) => undefined),
  listRotated: vi.fn(async () => [] as Array<{ sourceId: string; publicKey: string; name: string | null; storedKid: string }>),
  listStored: vi.fn(async () => [] as Array<{ sourceId: string; publicKey: string; name: string | null }>),
  currentFingerprint: 'deadbeef',
};
vi.mock('../services/meshcoreCredentialStore.js', () => ({
  getMeshCoreCredentialStore: () => fakeCredentialStore,
  setMeshCoreCredentialStoreForTesting: vi.fn(),
}));

// Disable rate limiting in tests. The 60-req/min bucket is enough for the
// original test set but pushed over by the new login-with-saved cases,
// causing unrelated tests downstream to fail with 429s.
vi.mock('../middleware/rateLimiters.js', () => {
  const passthrough = (_req: any, _res: any, next: any) => next();
  return {
    apiLimiter: passthrough,
    authLimiter: passthrough,
    messageLimiter: passthrough,
    meshcoreDeviceLimiter: passthrough,
  };
});

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

// Mock the MeshCore packet-log service so the packet-monitor routes don't hit
// the (fully-mocked) database. Hoisted so the vi.mock factory can reference it.
const mockPacketService = vi.hoisted(() => ({
  getPackets: vi.fn(),
  getPacketCount: vi.fn(),
  getMaxCount: vi.fn(),
  getMaxAgeHours: vi.fn(),
  isEnabled: vi.fn(),
  clearPackets: vi.fn(),
}));
vi.mock('../services/meshcorePacketLogService.js', () => ({ default: mockPacketService }));

import DatabaseService from '../../services/database.js';

import meshcoreRoutes from './meshcoreRoutes.js';
import authRoutes from './authRoutes.js';
import { setMeshCoreRemoteTelemetryScheduler } from '../services/meshcoreRemoteTelemetryScheduler.js';

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
    // Spy on auditLogAsync so tests can assert specific routes fired the
    // expected event. Returns a resolved promise so the fire-and-forget
    // .catch() in the route helper has something to chain.
    (DatabaseService as any).auditLogAsync = vi.fn(async () => undefined);
    (DatabaseService as any).drizzleDbType = 'sqlite';

    (DatabaseService as any).settings = {
      getSetting: vi.fn(async () => null),
    };

    // Saved-regions catalog mock (#3770). Tests override these per-case.
    (DatabaseService as any).savedRegions = {
      getAllAsync: vi.fn(async () => []),
      addAsync: vi.fn(async (name: string, note?: string | null) => ({
        id: 1, name: name.toLowerCase().replace(/^#/, ''), note: note ?? null, createdAt: 1, updatedAt: 1,
      })),
      deleteAsync: vi.fn(async () => undefined),
    };

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
    for (const resource of ['connection', 'nodes', 'messages', 'configuration', 'remote_admin', 'packetmonitor'] as const) {
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

    for (const resource of ['connection', 'nodes', 'messages', 'configuration', 'remote_admin', 'packetmonitor'] as const) {
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

  describe('Saved regions catalog (#3770)', () => {
    it('GET /saved-regions lists regions', async () => {
      (DatabaseService as any).savedRegions.getAllAsync.mockResolvedValueOnce([
        { id: 1, name: 'muenchen', note: null, createdAt: 1, updatedAt: 1 },
      ]);
      const response = await authenticatedAgent.get('/api/sources/test-source/meshcore/saved-regions');
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.regions).toHaveLength(1);
      expect(response.body.regions[0].name).toBe('muenchen');
    });

    it('GET /saved-regions requires authentication', async () => {
      const response = await request(app).get('/api/sources/test-source/meshcore/saved-regions');
      expect(response.status).toBe(401);
    });

    it('POST /saved-regions adds a region', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/saved-regions')
        .send({ name: '#Muenchen' });
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect((DatabaseService as any).savedRegions.addAsync).toHaveBeenCalledWith('#Muenchen', null);
    });

    it('POST /saved-regions rejects a missing name', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/saved-regions')
        .send({ note: 'no name' });
      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it('POST /saved-regions surfaces an invalid-name error as 400', async () => {
      (DatabaseService as any).savedRegions.addAsync.mockRejectedValueOnce(
        new Error('Invalid region name (letters, digits and hyphens only)'),
      );
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/saved-regions')
        .send({ name: '###' });
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/Invalid region name/);
    });

    it('DELETE /saved-regions/:id deletes a region', async () => {
      const response = await authenticatedAgent
        .delete('/api/sources/test-source/meshcore/saved-regions/5');
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect((DatabaseService as any).savedRegions.deleteAsync).toHaveBeenCalledWith(5);
    });

    it('DELETE /saved-regions/:id rejects an invalid id', async () => {
      const response = await authenticatedAgent
        .delete('/api/sources/test-source/meshcore/saved-regions/abc');
      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
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

  describe('POST /api/sources/test-source/meshcore/admin/cli', () => {
    const validKey = 'a'.repeat(64);

    beforeEach(() => {
      meshcoreManager.sendCliCommand.mockReset();
      meshcoreManager.sendCliCommand.mockResolvedValue({ reply: 'v1.7.0', elapsedMs: 73 });
    });

    it('requires authentication', async () => {
      const response = await request(app)
        .post('/api/sources/test-source/meshcore/admin/cli')
        .send({ publicKey: validKey, command: 'ver' });
      expect(response.status).toBe(401);
    });

    it('rejects an invalid public key', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/admin/cli')
        .send({ publicKey: 'short', command: 'ver' });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('public key');
    });

    it('rejects an empty command', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/admin/cli')
        .send({ publicKey: validKey, command: '   ' });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('non-empty');
    });

    it('rejects a command longer than the LoRa MTU', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/admin/cli')
        .send({ publicKey: validKey, command: 'x'.repeat(231) });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('too long');
    });

    it('returns the reply on the happy path', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/admin/cli')
        .send({ publicKey: validKey, command: 'ver' });
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toEqual({ reply: 'v1.7.0', elapsedMs: 73 });
      expect(meshcoreManager.sendCliCommand).toHaveBeenCalledWith(validKey, 'ver', {
        timeoutMs: undefined,
      });
    });

    it('maps a timeout to 504', async () => {
      meshcoreManager.sendCliCommand.mockRejectedValueOnce(
        new Error('CLI command timed out after 15000ms'),
      );
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/admin/cli')
        .send({ publicKey: validKey, command: 'ver' });
      expect(response.status).toBe(504);
      expect(response.body.code).toBe('CLI_TIMEOUT');
    });

    it('honors a caller-supplied timeoutMs', async () => {
      await authenticatedAgent
        .post('/api/sources/test-source/meshcore/admin/cli')
        .send({ publicKey: validKey, command: 'ver', timeoutMs: 5000 });
      expect(meshcoreManager.sendCliCommand).toHaveBeenCalledWith(validKey, 'ver', {
        timeoutMs: 5000,
      });
    });

    it.each([
      ['reboot'],
      ['Reboot'],
      ['erase'],
      ['clkreboot'],
      ['factory reset'],
      ['set factory mode'],
    ])('rejects danger command %s without confirm', async (cmd) => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/admin/cli')
        .send({ publicKey: validKey, command: cmd });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('DANGER_CONFIRM_REQUIRED');
      expect(meshcoreManager.sendCliCommand).not.toHaveBeenCalled();
    });

    it('accepts a danger command when confirm=true', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/admin/cli')
        .send({ publicKey: validKey, command: 'reboot', confirm: true });
      expect(response.status).toBe(200);
      expect(meshcoreManager.sendCliCommand).toHaveBeenCalledWith(validKey, 'reboot', {
        timeoutMs: undefined,
      });
    });

    it('does not require confirm for non-danger commands', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/admin/cli')
        .send({ publicKey: validKey, command: 'stats' });
      expect(response.status).toBe(200);
    });
  });

  describe('GET /api/sources/test-source/meshcore/admin/credentials-capability', () => {
    beforeEach(() => {
      fakeCredentialStore.capability = { canRemember: true, reason: undefined };
      fakeCredentialStore.listRotated.mockReset();
      fakeCredentialStore.listRotated.mockResolvedValue([]);
    });

    it('reports canRemember=true when SESSION_SECRET is configured', async () => {
      const response = await authenticatedAgent.get(
        '/api/sources/test-source/meshcore/admin/credentials-capability',
      );
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.canRemember).toBe(true);
      expect(response.body.data.rotatedCount).toBe(0);
    });

    it('reports canRemember=false when SESSION_SECRET is auto-generated', async () => {
      fakeCredentialStore.capability = { canRemember: false, reason: 'SESSION_SECRET not configured' };
      const response = await authenticatedAgent.get(
        '/api/sources/test-source/meshcore/admin/credentials-capability',
      );
      expect(response.status).toBe(200);
      expect(response.body.data.canRemember).toBe(false);
      expect(response.body.data.reason).toContain('SESSION_SECRET');
    });

    it('filters rotated entries to the requested source', async () => {
      const pk1 = 'a'.repeat(64);
      const pk2 = 'b'.repeat(64);
      fakeCredentialStore.listRotated.mockResolvedValue([
        { sourceId: 'test-source', publicKey: pk1, name: 'Hill repeater', storedKid: 'cafe1234' },
        { sourceId: 'other-source', publicKey: pk2, name: 'Other repeater', storedKid: 'cafe1234' },
      ]);
      const response = await authenticatedAgent.get(
        '/api/sources/test-source/meshcore/admin/credentials-capability',
      );
      expect(response.status).toBe(200);
      expect(response.body.data.rotatedCount).toBe(1);
      expect(response.body.data.rotated).toEqual([{ publicKey: pk1, name: 'Hill repeater' }]);
    });
  });

  describe('POST /api/sources/test-source/meshcore/cli (local)', () => {
    beforeEach(() => {
      meshcoreManager.sendLocalCliCommand.mockReset();
      meshcoreManager.sendLocalCliCommand.mockResolvedValue({ reply: 'v1.7.0', elapsedMs: 12 });
    });

    it('requires authentication', async () => {
      const response = await request(app)
        .post('/api/sources/test-source/meshcore/cli')
        .send({ command: 'ver' });
      expect(response.status).toBe(401);
    });

    it('rejects an empty command', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/cli')
        .send({ command: '   ' });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('non-empty');
    });

    it('rejects a command longer than the LoRa MTU', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/cli')
        .send({ command: 'x'.repeat(231) });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('too long');
    });

    it('returns the reply on the happy path', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/cli')
        .send({ command: 'ver' });
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toEqual({ reply: 'v1.7.0', elapsedMs: 12 });
      expect(meshcoreManager.sendLocalCliCommand).toHaveBeenCalledWith('ver', {
        timeoutMs: undefined,
      });
    });

    it.each([
      ['reboot'],
      ['Reboot'],
      ['erase'],
      ['clkreboot'],
      ['factory reset'],
    ])('rejects danger command %s without confirm', async (cmd) => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/cli')
        .send({ command: cmd });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('DANGER_CONFIRM_REQUIRED');
      expect(meshcoreManager.sendLocalCliCommand).not.toHaveBeenCalled();
    });

    it('accepts a danger command when confirm=true', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/cli')
        .send({ command: 'reboot', confirm: true });
      expect(response.status).toBe(200);
      expect(meshcoreManager.sendLocalCliCommand).toHaveBeenCalledWith('reboot', {
        timeoutMs: undefined,
      });
    });

    it('maps a timeout to 504', async () => {
      meshcoreManager.sendLocalCliCommand.mockRejectedValueOnce(
        new Error('CLI command timed out after 10000ms'),
      );
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/cli')
        .send({ command: 'stats' });
      expect(response.status).toBe(504);
      expect(response.body.code).toBe('CLI_TIMEOUT');
    });

    it('maps a "not available for this device type" failure to 400', async () => {
      meshcoreManager.sendLocalCliCommand.mockRejectedValueOnce(
        new Error('Local CLI not available for this device type'),
      );
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/cli')
        .send({ command: 'ver' });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('not available');
    });
  });

  describe('POST /admin/login with rememberPassword', () => {
    const validKey = 'a'.repeat(64);

    beforeEach(() => {
      fakeCredentialStore.capability = { canRemember: true, reason: undefined };
      fakeCredentialStore.store.mockReset();
      fakeCredentialStore.store.mockResolvedValue(undefined);
      meshcoreManager.loginToNode.mockResolvedValue(true);
    });

    it('rejects rememberPassword=true when SESSION_SECRET is ephemeral', async () => {
      fakeCredentialStore.capability = { canRemember: false, reason: 'SESSION_SECRET not configured' };
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/admin/login')
        .send({ publicKey: validKey, password: 'admin', rememberPassword: true });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('CREDENTIAL_PERSISTENCE_DISABLED');
      expect(fakeCredentialStore.store).not.toHaveBeenCalled();
    });

    it('persists the password when rememberPassword=true and capability allows', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/admin/login')
        .send({ publicKey: validKey, password: 'admin', rememberPassword: true });
      expect(response.status).toBe(200);
      expect(response.body.persisted).toBe(true);
      expect(fakeCredentialStore.store).toHaveBeenCalledWith('test-source', validKey, 'admin');
    });

    it('does not persist when rememberPassword is omitted', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/admin/login')
        .send({ publicKey: validKey, password: 'admin' });
      expect(response.status).toBe(200);
      expect(response.body.persisted).toBe(false);
      expect(fakeCredentialStore.store).not.toHaveBeenCalled();
    });

    it('accepts an empty password (guest login)', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/admin/login')
        .send({ publicKey: validKey, password: '' });
      expect(response.status).toBe(200);
      expect(meshcoreManager.loginToNode).toHaveBeenCalledWith(validKey, '');
    });
  });

  describe('POST /api/sources/test-source/meshcore/admin/login-with-saved', () => {
    const validKey = 'a'.repeat(64);
    const SECRET = 'top-secret-password-that-must-never-leak-to-the-client';

    beforeEach(() => {
      fakeCredentialStore.load.mockReset();
      meshcoreManager.loginToNode.mockReset();
      meshcoreManager.loginToNode.mockResolvedValue(true);
    });

    it('rejects an invalid public key', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/admin/login-with-saved')
        .send({ publicKey: 'nope' });
      expect(response.status).toBe(400);
    });

    it('returns 404 NO_STORED_CREDENTIAL when nothing is saved', async () => {
      fakeCredentialStore.load.mockResolvedValue({ kind: 'none' });
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/admin/login-with-saved')
        .send({ publicKey: validKey });
      expect(response.status).toBe(404);
      expect(response.body.code).toBe('NO_STORED_CREDENTIAL');
      expect(meshcoreManager.loginToNode).not.toHaveBeenCalled();
    });

    it('returns 410 CREDENTIAL_KEY_ROTATED when stored kid no longer matches', async () => {
      fakeCredentialStore.load.mockResolvedValue({ kind: 'key_rotated', storedKid: 'feedface' });
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/admin/login-with-saved')
        .send({ publicKey: validKey });
      expect(response.status).toBe(410);
      expect(response.body.code).toBe('CREDENTIAL_KEY_ROTATED');
      // Stored fingerprint MUST NOT leak — even though it's "just" a 4-byte
      // hash, exposing it would let a hostile script enumerate rotations.
      expect(JSON.stringify(response.body)).not.toContain('feedface');
      expect(meshcoreManager.loginToNode).not.toHaveBeenCalled();
    });

    it('returns 401 STORED_CREDENTIAL_REJECTED when the remote refuses the saved password', async () => {
      fakeCredentialStore.load.mockResolvedValue({ kind: 'ok', password: SECRET });
      meshcoreManager.loginToNode.mockResolvedValue(false);
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/admin/login-with-saved')
        .send({ publicKey: validKey });
      expect(response.status).toBe(401);
      expect(response.body.code).toBe('STORED_CREDENTIAL_REJECTED');
      // Even in the failure path, the password must not be echoed back.
      expect(JSON.stringify(response.body)).not.toContain(SECRET);
    });

    it('succeeds when the saved credential decrypts and the remote accepts it', async () => {
      fakeCredentialStore.load.mockResolvedValue({ kind: 'ok', password: SECRET });
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/admin/login-with-saved')
        .send({ publicKey: validKey });
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.usedStored).toBe(true);
      expect(meshcoreManager.loginToNode).toHaveBeenCalledWith(validKey, SECRET);
    });

    /**
     * SECURITY INVARIANT: the saved plaintext password must NEVER appear
     * in any HTTP response body, in any status code path. This test is
     * the canary — if it fails, audit every change to the route since
     * the last green run.
     */
    it('NEVER returns the saved password in the response body', async () => {
      const cases: Array<[Awaited<ReturnType<typeof fakeCredentialStore.load>>, boolean]> = [
        [{ kind: 'none' }, false],
        [{ kind: 'key_rotated', storedKid: 'beefcafe' }, false],
        [{ kind: 'ok', password: SECRET }, true],
        [{ kind: 'ok', password: SECRET }, false], // remote rejects
      ];
      for (const [loadResult, remoteAccepts] of cases) {
        fakeCredentialStore.load.mockResolvedValueOnce(loadResult);
        meshcoreManager.loginToNode.mockResolvedValueOnce(remoteAccepts);
        const response = await authenticatedAgent
          .post('/api/sources/test-source/meshcore/admin/login-with-saved')
          .send({ publicKey: validKey });
        expect(JSON.stringify(response.body)).not.toContain(SECRET);
      }
    });

    it('does not require client to send a password (body is { publicKey } only)', async () => {
      fakeCredentialStore.load.mockResolvedValue({ kind: 'ok', password: SECRET });
      await authenticatedAgent
        .post('/api/sources/test-source/meshcore/admin/login-with-saved')
        .send({ publicKey: validKey });
      // loginToNode received the SERVER-side decrypted password, not
      // anything the client supplied (the client supplied no password).
      expect(meshcoreManager.loginToNode).toHaveBeenCalledWith(validKey, SECRET);
    });
  });

  describe('GET /credentials-capability includes stored[]', () => {
    beforeEach(() => {
      fakeCredentialStore.capability = { canRemember: true, reason: undefined };
      fakeCredentialStore.listRotated.mockReset();
      fakeCredentialStore.listRotated.mockResolvedValue([]);
      fakeCredentialStore.listStored.mockReset();
      fakeCredentialStore.listStored.mockResolvedValue([]);
    });

    it('filters stored entries to the requested source', async () => {
      const pk1 = 'a'.repeat(64);
      const pk2 = 'b'.repeat(64);
      fakeCredentialStore.listStored.mockResolvedValue([
        { sourceId: 'test-source', publicKey: pk1, name: 'My repeater' },
        { sourceId: 'other-source', publicKey: pk2, name: 'Other repeater' },
      ]);
      const response = await authenticatedAgent.get(
        '/api/sources/test-source/meshcore/admin/credentials-capability',
      );
      expect(response.status).toBe(200);
      expect(response.body.data.stored).toEqual([{ publicKey: pk1, name: 'My repeater' }]);
    });
  });

  describe('DELETE /api/sources/test-source/meshcore/admin/credentials/:publicKey', () => {
    const validKey = 'a'.repeat(64);

    beforeEach(() => {
      fakeCredentialStore.clear.mockReset();
      fakeCredentialStore.clear.mockResolvedValue(undefined);
    });

    it('rejects an invalid public key', async () => {
      const response = await authenticatedAgent.delete(
        '/api/sources/test-source/meshcore/admin/credentials/not-hex',
      );
      expect(response.status).toBe(400);
    });

    it('clears a saved credential and returns success', async () => {
      const response = await authenticatedAgent.delete(
        `/api/sources/test-source/meshcore/admin/credentials/${validKey}`,
      );
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(fakeCredentialStore.clear).toHaveBeenCalledWith('test-source', validKey);
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

  describe('POST /api/sources/test-source/meshcore/config/sync-time', () => {
    it('should require authentication', async () => {
      const response = await request(app)
        .post('/api/sources/test-source/meshcore/config/sync-time');
      expect(response.status).toBe(401);
    });

    it('returns 200 when the device time sync succeeds', async () => {
      meshcoreManager.syncDeviceTime.mockResolvedValueOnce({ ok: true });
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/config/sync-time');
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('returns 409 for the guard cases (not a Companion / disconnected)', async () => {
      meshcoreManager.syncDeviceTime.mockResolvedValueOnce({ ok: false, reason: 'not-companion' });
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/config/sync-time');
      expect(response.status).toBe(409);
      expect(response.body.error).toMatch(/Companion device/i);
    });

    it('returns 502 with the real reason when the device rejects the command (issue #3570)', async () => {
      meshcoreManager.syncDeviceTime.mockResolvedValueOnce({
        ok: false,
        reason: 'command-failed',
        error: 'device returned Err to set_device_time (firmware may not support setting the RTC over this transport)',
      });
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/config/sync-time');
      expect(response.status).toBe(502);
      // The misleading "disconnected or not a Companion device" must NOT appear.
      expect(response.body.error).not.toMatch(/disconnected or not a Companion/i);
      expect(response.body.error).toMatch(/Device rejected the time-sync command/i);
      expect(response.body.error).toMatch(/firmware may not support/i);
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

  describe('PATCH /api/sources/test-source/meshcore/nodes/:publicKey/telemetry-config', () => {
    const REPEATER_PUBKEY = 'f'.repeat(64);
    const upsertNode = vi.fn().mockResolvedValue(undefined);
    const setNodeTelemetryConfig = vi.fn().mockResolvedValue(undefined);
    const getNodeByPublicKeyAndSource = vi.fn().mockResolvedValue({
      publicKey: REPEATER_PUBKEY,
      telemetryEnabled: true,
      telemetryIntervalMinutes: 60,
      lastTelemetryRequestAt: null,
    });

    beforeEach(() => {
      // Inject the meshcore repo facade onto the mocked DatabaseService.
      // Done in beforeEach so the function refs survive the global
      // `vi.clearAllMocks()` (which clears call history but not impls).
      (DatabaseService as any).meshcore = {
        upsertNode,
        setNodeTelemetryConfig,
        getNodeByPublicKeyAndSource,
      };
      upsertNode.mockClear();
      setNodeTelemetryConfig.mockClear();
      getNodeByPublicKeyAndSource.mockClear();
      meshcoreManager.getContact.mockReset();
    });

    it('backfills advType + advName from the in-memory contact before seeding the telemetry-config row', async () => {
      // Regression for issue #3092: the route used to call only
      // setNodeTelemetryConfig, which inserts a stub row with advType=null.
      // The remote-telemetry scheduler then treated every target as a
      // Companion (`isRepeaterLike=false`) and skipped the SendStatusReq +
      // guest-login paths added in #3094.
      meshcoreManager.getContact.mockReturnValueOnce({
        publicKey: REPEATER_PUBKEY,
        advName: 'MyRepeater',
        advType: 2, // REPEATER
        latitude: 51.0,
        longitude: 0.0,
        lastSeen: 1_700_000_000_000,
      });

      const response = await authenticatedAgent
        .patch(`/api/sources/test-source/meshcore/nodes/${REPEATER_PUBKEY}/telemetry-config`)
        .send({ enabled: true, intervalMinutes: 30 });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      // The contact backfill must run BEFORE the telemetry-config seed
      // so the seed's getOrInsert path sees the populated row and only
      // patches its telemetry columns.
      expect(upsertNode).toHaveBeenCalledTimes(1);
      expect(upsertNode).toHaveBeenCalledWith(
        expect.objectContaining({
          publicKey: REPEATER_PUBKEY,
          name: 'MyRepeater',
          advType: 2,
        }),
        'test-source',
      );
      expect(setNodeTelemetryConfig).toHaveBeenCalledWith(
        'test-source',
        REPEATER_PUBKEY,
        { enabled: true, intervalMinutes: 30 },
      );
      // Order: backfill upsert → telemetry-config patch.
      const upsertOrder = upsertNode.mock.invocationCallOrder[0];
      const setCfgOrder = setNodeTelemetryConfig.mock.invocationCallOrder[0];
      expect(upsertOrder).toBeLessThan(setCfgOrder);
    });

    it('skips the backfill upsert when the contact is not yet in memory', async () => {
      // User enables telemetry-retrieval on a publicKey we haven't
      // received an advert for yet. The route must still create the
      // telemetry-config row; backfill happens when the contact arrives.
      meshcoreManager.getContact.mockReturnValueOnce(undefined);

      const response = await authenticatedAgent
        .patch(`/api/sources/test-source/meshcore/nodes/${REPEATER_PUBKEY}/telemetry-config`)
        .send({ enabled: true });

      expect(response.status).toBe(200);
      expect(upsertNode).not.toHaveBeenCalled();
      expect(setNodeTelemetryConfig).toHaveBeenCalledTimes(1);
    });
  });

  describe('POST /api/sources/test-source/meshcore/nodes/:publicKey/telemetry/poll', () => {
    const POLL_PUBKEY = 'a'.repeat(64);
    const MALFORMED = 'abcd1234';
    const getNodeByPublicKeyAndSource = vi.fn();
    const markTelemetryRequested = vi.fn();
    const requestTelemetryForNode = vi.fn();

    beforeEach(() => {
      (DatabaseService as any).meshcore = {
        getNodeByPublicKeyAndSource,
        markTelemetryRequested,
      };
      getNodeByPublicKeyAndSource.mockReset().mockResolvedValue({ publicKey: POLL_PUBKEY, advType: 2 });
      markTelemetryRequested.mockReset().mockResolvedValue(undefined);
      requestTelemetryForNode.mockReset().mockResolvedValue({ written: 16, sources: ['status:16'] });
      meshcoreManager.isConnected.mockReturnValue(true);
      meshcoreManager.getLastMeshTxAt.mockReturnValue(0);
      meshcoreManager.recordMeshTx.mockReset();
      setMeshCoreRemoteTelemetryScheduler({ requestTelemetryForNode } as any);
    });

    afterEach(() => {
      setMeshCoreRemoteTelemetryScheduler(null);
      meshcoreManager.isConnected.mockReturnValue(false);
      meshcoreManager.getLastMeshTxAt.mockReturnValue(0);
    });

    it('requires authentication', async () => {
      const res = await request(app)
        .post(`/api/sources/test-source/meshcore/nodes/${POLL_PUBKEY}/telemetry/poll`)
        .send({ type: 'status' });
      expect(res.status).toBe(401);
    });

    it('rejects a malformed public key', async () => {
      const res = await authenticatedAgent
        .post(`/api/sources/test-source/meshcore/nodes/${MALFORMED}/telemetry/poll`)
        .send({ type: 'status' });
      expect(res.status).toBe(400);
    });

    it('rejects an invalid poll type', async () => {
      const res = await authenticatedAgent
        .post(`/api/sources/test-source/meshcore/nodes/${POLL_PUBKEY}/telemetry/poll`)
        .send({ type: 'bogus' });
      expect(res.status).toBe(400);
      expect(requestTelemetryForNode).not.toHaveBeenCalled();
    });

    it('polls status: stamps the gate and returns the written count', async () => {
      const res = await authenticatedAgent
        .post(`/api/sources/test-source/meshcore/nodes/${POLL_PUBKEY}/telemetry/poll`)
        .send({ type: 'status' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toMatchObject({ type: 'status', written: 16 });
      expect(requestTelemetryForNode).toHaveBeenCalledWith(
        meshcoreManager,
        { publicKey: POLL_PUBKEY, advType: 2 },
        { includeStatus: true, includeLpp: false },
      );
      expect(meshcoreManager.recordMeshTx).toHaveBeenCalledTimes(1);
      expect(markTelemetryRequested).toHaveBeenCalledWith('test-source', POLL_PUBKEY, expect.any(Number));
    });

    it('polls lpp with includeLpp set', async () => {
      requestTelemetryForNode.mockResolvedValueOnce({ written: 3, sources: ['lpp:3'] });
      const res = await authenticatedAgent
        .post(`/api/sources/test-source/meshcore/nodes/${POLL_PUBKEY}/telemetry/poll`)
        .send({ type: 'lpp' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ type: 'lpp', written: 3 });
      expect(requestTelemetryForNode).toHaveBeenCalledWith(
        meshcoreManager,
        expect.objectContaining({ publicKey: POLL_PUBKEY }),
        { includeStatus: false, includeLpp: true },
      );
    });

    it('treats an unknown node as a companion (advType null)', async () => {
      getNodeByPublicKeyAndSource.mockResolvedValueOnce(null);
      const res = await authenticatedAgent
        .post(`/api/sources/test-source/meshcore/nodes/${POLL_PUBKEY}/telemetry/poll`)
        .send({ type: 'lpp' });
      expect(res.status).toBe(200);
      expect(requestTelemetryForNode).toHaveBeenCalledWith(
        meshcoreManager,
        { publicKey: POLL_PUBKEY, advType: null },
        { includeStatus: false, includeLpp: true },
      );
    });

    it('returns 409 when the source is not connected', async () => {
      meshcoreManager.isConnected.mockReturnValue(false);
      const res = await authenticatedAgent
        .post(`/api/sources/test-source/meshcore/nodes/${POLL_PUBKEY}/telemetry/poll`)
        .send({ type: 'status' });
      expect(res.status).toBe(409);
      expect(requestTelemetryForNode).not.toHaveBeenCalled();
    });

    it('enforces the 60s mesh-TX gate with 429 + Retry-After', async () => {
      meshcoreManager.getLastMeshTxAt.mockReturnValue(Date.now() - 5_000);
      const res = await authenticatedAgent
        .post(`/api/sources/test-source/meshcore/nodes/${POLL_PUBKEY}/telemetry/poll`)
        .send({ type: 'status' });
      expect(res.status).toBe(429);
      expect(res.body.retryAfterSecs).toBeGreaterThan(0);
      expect(res.headers['retry-after']).toBeDefined();
      expect(requestTelemetryForNode).not.toHaveBeenCalled();
      expect(meshcoreManager.recordMeshTx).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/sources/test-source/meshcore/nodes/:publicKey/favorite', () => {
    const FAV_PUBKEY = 'c'.repeat(64);
    const MALFORMED = 'abcd1234';
    const upsertNode = vi.fn().mockResolvedValue(undefined);

    beforeEach(() => {
      (DatabaseService as any).meshcore = { upsertNode };
      upsertNode.mockClear();
      meshcoreManager.setNodeFavorite.mockReset();
      meshcoreManager.setNodeFavorite.mockResolvedValue(undefined);
      meshcoreManager.getContact.mockReset();
    });

    it('requires authentication', async () => {
      const response = await request(app)
        .post(`/api/sources/test-source/meshcore/nodes/${FAV_PUBKEY}/favorite`)
        .send({ isFavorite: true });
      expect(response.status).toBe(401);
    });

    it('rejects a malformed public key', async () => {
      const response = await authenticatedAgent
        .post(`/api/sources/test-source/meshcore/nodes/${MALFORMED}/favorite`)
        .send({ isFavorite: true });
      expect(response.status).toBe(400);
    });

    it('rejects a non-boolean isFavorite', async () => {
      const response = await authenticatedAgent
        .post(`/api/sources/test-source/meshcore/nodes/${FAV_PUBKEY}/favorite`)
        .send({ isFavorite: 'yes' });
      expect(response.status).toBe(400);
      expect(meshcoreManager.setNodeFavorite).not.toHaveBeenCalled();
    });

    it('favorites a node locally without any device round-trip', async () => {
      meshcoreManager.getContact.mockReturnValueOnce(undefined);
      const response = await authenticatedAgent
        .post(`/api/sources/test-source/meshcore/nodes/${FAV_PUBKEY}/favorite`)
        .send({ isFavorite: true });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toMatchObject({ publicKey: FAV_PUBKEY, isFavorite: true });
      expect(meshcoreManager.setNodeFavorite).toHaveBeenCalledWith(FAV_PUBKEY, true);
    });

    it('backfills identity from the in-memory contact before seeding the row', async () => {
      meshcoreManager.getContact.mockReturnValueOnce({
        publicKey: FAV_PUBKEY,
        advName: 'MyRepeater',
        advType: 2,
        lastSeen: 1_700_000_000_000,
      });

      const response = await authenticatedAgent
        .post(`/api/sources/test-source/meshcore/nodes/${FAV_PUBKEY}/favorite`)
        .send({ isFavorite: true });

      expect(response.status).toBe(200);
      expect(upsertNode).toHaveBeenCalledWith(
        expect.objectContaining({ publicKey: FAV_PUBKEY, name: 'MyRepeater', advType: 2 }),
        'test-source',
      );
      expect(meshcoreManager.setNodeFavorite).toHaveBeenCalledWith(FAV_PUBKEY, true);
    });

    it('un-favorites a node', async () => {
      meshcoreManager.getContact.mockReturnValueOnce(undefined);
      const response = await authenticatedAgent
        .post(`/api/sources/test-source/meshcore/nodes/${FAV_PUBKEY}/favorite`)
        .send({ isFavorite: false });

      expect(response.status).toBe(200);
      expect(meshcoreManager.setNodeFavorite).toHaveBeenCalledWith(FAV_PUBKEY, false);
    });
  });

  describe('DELETE /api/sources/test-source/meshcore/contacts/:publicKey', () => {
    const VALID_PUBKEY = 'a'.repeat(64);
    const MALFORMED_PUBKEY = 'abcd1234'; // short / not 64-char hex (issue #3443)

    beforeEach(() => {
      meshcoreManager.removeContact.mockReset();
      meshcoreManager.removeContact.mockResolvedValue(true);
      meshcoreManager.forgetLocalContact.mockReset();
      meshcoreManager.forgetLocalContact.mockResolvedValue(true);
    });

    it('requires authentication', async () => {
      const response = await request(app)
        .delete(`/api/sources/test-source/meshcore/contacts/${VALID_PUBKEY}`);
      expect(response.status).toBe(401);
    });

    it('removes a valid contact via the device path (no local fallback)', async () => {
      const response = await authenticatedAgent
        .delete(`/api/sources/test-source/meshcore/contacts/${VALID_PUBKEY}`);
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(meshcoreManager.removeContact).toHaveBeenCalledWith(VALID_PUBKEY);
      expect(meshcoreManager.forgetLocalContact).not.toHaveBeenCalled();
    });

    it('removes a malformed/short public key (no format guard — issue #3443)', async () => {
      // Device-side removal can't match a ghost/truncated key, so it returns
      // false; the route must fall back to forgetting the local DB row.
      meshcoreManager.removeContact.mockResolvedValueOnce(false);
      const response = await authenticatedAgent
        .delete(`/api/sources/test-source/meshcore/contacts/${MALFORMED_PUBKEY}`);
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(meshcoreManager.removeContact).toHaveBeenCalledWith(MALFORMED_PUBKEY);
      expect(meshcoreManager.forgetLocalContact).toHaveBeenCalledWith(MALFORMED_PUBKEY);
    });

    it('falls back to local cleanup when the device removal fails for any key', async () => {
      meshcoreManager.removeContact.mockResolvedValueOnce(false);
      const response = await authenticatedAgent
        .delete(`/api/sources/test-source/meshcore/contacts/${VALID_PUBKEY}`);
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(meshcoreManager.forgetLocalContact).toHaveBeenCalledWith(VALID_PUBKEY);
    });

    it('returns 409 only when both device removal and local cleanup fail', async () => {
      meshcoreManager.removeContact.mockResolvedValueOnce(false);
      meshcoreManager.forgetLocalContact.mockResolvedValueOnce(false);
      const response = await authenticatedAgent
        .delete(`/api/sources/test-source/meshcore/contacts/${VALID_PUBKEY}`);
      expect(response.status).toBe(409);
      expect(response.body.success).toBe(false);
    });

    it('returns 404 when the source has no registered manager', async () => {
      const response = await authenticatedAgent
        .delete(`/api/sources/no-such-source/meshcore/contacts/${VALID_PUBKEY}`);
      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/sources/test-source/meshcore/contacts/:publicKey/reset-path', () => {
    const VALID_PUBKEY = 'a'.repeat(64);

    beforeEach(() => {
      meshcoreManager.resetContactPath.mockReset();
      meshcoreManager.resetContactPath.mockResolvedValue(true);
    });

    it('requires authentication', async () => {
      const response = await request(app)
        .post(`/api/sources/test-source/meshcore/contacts/${VALID_PUBKEY}/reset-path`);
      expect(response.status).toBe(401);
    });

    it('rejects an invalid public key', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/contacts/not-hex/reset-path');
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/64-char hex/);
      expect(meshcoreManager.resetContactPath).not.toHaveBeenCalled();
    });

    it('forwards a valid public key to the manager and returns 200', async () => {
      const response = await authenticatedAgent
        .post(`/api/sources/test-source/meshcore/contacts/${VALID_PUBKEY}/reset-path`);
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(meshcoreManager.resetContactPath).toHaveBeenCalledWith(VALID_PUBKEY);
    });

    it('returns 409 when the manager rejects (unknown contact / non-companion)', async () => {
      meshcoreManager.resetContactPath.mockResolvedValueOnce(false);
      const response = await authenticatedAgent
        .post(`/api/sources/test-source/meshcore/contacts/${VALID_PUBKEY}/reset-path`);
      expect(response.status).toBe(409);
      expect(response.body.success).toBe(false);
    });

    it('returns 404 when the source has no registered manager', async () => {
      const response = await authenticatedAgent
        .post(`/api/sources/no-such-source/meshcore/contacts/${VALID_PUBKEY}/reset-path`);
      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/sources/test-source/meshcore/contacts/:publicKey/discover-path', () => {
    const VALID_PUBKEY = 'c'.repeat(64);

    beforeEach(() => {
      meshcoreManager.discoverContactPath.mockReset();
      meshcoreManager.discoverContactPath.mockResolvedValue(true);
    });

    it('requires authentication', async () => {
      const response = await request(app)
        .post(`/api/sources/test-source/meshcore/contacts/${VALID_PUBKEY}/discover-path`);
      expect(response.status).toBe(401);
    });

    it('rejects an invalid public key', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/contacts/not-hex/discover-path');
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/64-char hex/);
      expect(meshcoreManager.discoverContactPath).not.toHaveBeenCalled();
    });

    it('forwards a valid public key to the manager and returns 200', async () => {
      const response = await authenticatedAgent
        .post(`/api/sources/test-source/meshcore/contacts/${VALID_PUBKEY}/discover-path`);
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(meshcoreManager.discoverContactPath).toHaveBeenCalledWith(VALID_PUBKEY);
    });

    it('returns 409 when the manager rejects (unknown contact / non-companion)', async () => {
      meshcoreManager.discoverContactPath.mockResolvedValueOnce(false);
      const response = await authenticatedAgent
        .post(`/api/sources/test-source/meshcore/contacts/${VALID_PUBKEY}/discover-path`);
      expect(response.status).toBe(409);
      expect(response.body.success).toBe(false);
    });

    it('returns 404 when the source has no registered manager', async () => {
      const response = await authenticatedAgent
        .post(`/api/sources/no-such-source/meshcore/contacts/${VALID_PUBKEY}/discover-path`);
      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/sources/test-source/meshcore/discover', () => {
    beforeEach(() => {
      meshcoreManager.discoverNodes.mockReset();
      meshcoreManager.discoverNodes.mockResolvedValue({ returned: 3, newCount: 2 });
    });

    it('requires authentication', async () => {
      const response = await request(app)
        .post('/api/sources/test-source/meshcore/discover')
        .send({ mode: 'nearby' });
      expect(response.status).toBe(401);
    });

    it('rejects an invalid mode', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/discover')
        .send({ mode: 'everything' });
      expect(response.status).toBe(400);
      expect(meshcoreManager.discoverNodes).not.toHaveBeenCalled();
    });

    it('maps "repeaters" to the Repeater|Room filter (0x0c)', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/discover')
        .send({ mode: 'repeaters' });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true, returned: 3, new: 2 });
      expect(meshcoreManager.discoverNodes).toHaveBeenCalledWith(0x0c);
    });

    it('maps "nearby" to the all-types filter (0x1e)', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/discover')
        .send({ mode: 'nearby' });
      expect(response.status).toBe(200);
      expect(meshcoreManager.discoverNodes).toHaveBeenCalledWith(0x1e);
    });

    it('maps "sensors" to the sensor-only filter (0x10)', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/discover')
        .send({ mode: 'sensors' });
      expect(response.status).toBe(200);
      expect(meshcoreManager.discoverNodes).toHaveBeenCalledWith(0x10);
    });

    it('returns 404 when the source has no registered manager', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/no-such-source/meshcore/discover')
        .send({ mode: 'nearby' });
      expect(response.status).toBe(404);
    });
  });

  describe('GET/POST /api/sources/test-source/meshcore/config/discoverable', () => {
    beforeEach(() => {
      meshcoreManager.getRespondToDiscovery.mockReset();
      meshcoreManager.getRespondToDiscovery.mockResolvedValue(false);
      meshcoreManager.setRespondToDiscovery.mockReset();
      meshcoreManager.setRespondToDiscovery.mockResolvedValue(undefined);
    });

    it('GET requires authentication', async () => {
      const response = await request(app)
        .get('/api/sources/test-source/meshcore/config/discoverable');
      expect(response.status).toBe(401);
    });

    it('GET returns the current discoverable state', async () => {
      meshcoreManager.getRespondToDiscovery.mockResolvedValueOnce(true);
      const response = await authenticatedAgent
        .get('/api/sources/test-source/meshcore/config/discoverable');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true, enabled: true });
    });

    it('POST rejects a non-boolean enabled', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/config/discoverable')
        .send({ enabled: 'yes' });
      expect(response.status).toBe(400);
      expect(meshcoreManager.setRespondToDiscovery).not.toHaveBeenCalled();
    });

    it('POST forwards the boolean to the manager', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/config/discoverable')
        .send({ enabled: true });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true, enabled: true });
      expect(meshcoreManager.setRespondToDiscovery).toHaveBeenCalledWith(true);
    });

    it('returns 404 when the source has no registered manager', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/no-such-source/meshcore/config/discoverable')
        .send({ enabled: true });
      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/sources/test-source/meshcore/contacts/:publicKey/share', () => {
    const VALID_PUBKEY = 'b'.repeat(64);

    beforeEach(() => {
      meshcoreManager.shareContact.mockReset();
      meshcoreManager.shareContact.mockResolvedValue({ ok: true });
    });

    it('requires authentication', async () => {
      const response = await request(app)
        .post(`/api/sources/test-source/meshcore/contacts/${VALID_PUBKEY}/share`);
      expect(response.status).toBe(401);
    });

    it('rejects an invalid public key', async () => {
      const response = await authenticatedAgent
        .post('/api/sources/test-source/meshcore/contacts/not-hex/share');
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/64-char hex/);
      expect(meshcoreManager.shareContact).not.toHaveBeenCalled();
    });

    it('forwards a valid public key to the manager and returns 200', async () => {
      const response = await authenticatedAgent
        .post(`/api/sources/test-source/meshcore/contacts/${VALID_PUBKEY}/share`);
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.broadcast).toBe(true);
      expect(meshcoreManager.shareContact).toHaveBeenCalledWith(VALID_PUBKEY);
    });

    it('returns 409 and forwards the manager error when the device rejects', async () => {
      meshcoreManager.shareContact.mockResolvedValueOnce({
        ok: false,
        error: 'Device rejected share-contact — the firmware may not support this command.',
      });
      const response = await authenticatedAgent
        .post(`/api/sources/test-source/meshcore/contacts/${VALID_PUBKEY}/share`);
      expect(response.status).toBe(409);
      expect(response.body.success).toBe(false);
      // Real reason is surfaced, not a hardcoded generic string.
      expect(response.body.error).toMatch(/firmware may not support/i);
    });

    it('returns 504 when the device did not respond (timeout)', async () => {
      meshcoreManager.shareContact.mockResolvedValueOnce({
        ok: false,
        error: 'Device did not respond to share-contact within 10s — the firmware may not support this command.',
      });
      const response = await authenticatedAgent
        .post(`/api/sources/test-source/meshcore/contacts/${VALID_PUBKEY}/share`);
      expect(response.status).toBe(504);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/did not respond/i);
    });

    it('returns 404 when the source has no registered manager', async () => {
      const response = await authenticatedAgent
        .post(`/api/sources/no-such-source/meshcore/contacts/${VALID_PUBKEY}/share`);
      expect(response.status).toBe(404);
    });
  });

  describe('PUT /api/sources/test-source/meshcore/contacts/:publicKey/out-path', () => {
    const VALID_PUBKEY = 'c'.repeat(64);

    beforeEach(() => {
      meshcoreManager.setContactOutPath.mockReset();
      meshcoreManager.setContactOutPath.mockResolvedValue(true);
    });

    it('requires authentication', async () => {
      const response = await request(app)
        .put(`/api/sources/test-source/meshcore/contacts/${VALID_PUBKEY}/out-path`)
        .send({ outPath: 'a3,7f,02' });
      expect(response.status).toBe(401);
    });

    it('rejects an invalid public key', async () => {
      const response = await authenticatedAgent
        .put('/api/sources/test-source/meshcore/contacts/not-hex/out-path')
        .send({ outPath: 'a3,7f,02' });
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/64-char hex/);
      expect(meshcoreManager.setContactOutPath).not.toHaveBeenCalled();
    });

    it('rejects a malformed hex chain', async () => {
      const response = await authenticatedAgent
        .put(`/api/sources/test-source/meshcore/contacts/${VALID_PUBKEY}/out-path`)
        .send({ outPath: 'a3,nothex,02' });
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/comma-separated hex/);
      expect(meshcoreManager.setContactOutPath).not.toHaveBeenCalled();
    });

    it('rejects an oversize path (>64 hops)', async () => {
      const oversized = Array(65).fill('aa').join(',');
      const response = await authenticatedAgent
        .put(`/api/sources/test-source/meshcore/contacts/${VALID_PUBKEY}/out-path`)
        .send({ outPath: oversized });
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/too long/);
      expect(meshcoreManager.setContactOutPath).not.toHaveBeenCalled();
    });

    it('forwards valid path bytes to the manager and returns 200', async () => {
      const response = await authenticatedAgent
        .put(`/api/sources/test-source/meshcore/contacts/${VALID_PUBKEY}/out-path`)
        .send({ outPath: 'a3,7f,02' });
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(meshcoreManager.setContactOutPath).toHaveBeenCalledTimes(1);
      const [pk, bytes, hashBytes] = meshcoreManager.setContactOutPath.mock.calls[0];
      expect(pk).toBe(VALID_PUBKEY);
      expect(Array.from(bytes)).toEqual([0xa3, 0x7f, 0x02]);
      expect(hashBytes).toBe(1); // defaults to 1-byte when omitted
    });

    it('forwards a 2-byte-width path as flat bytes plus hashBytes=2', async () => {
      const response = await authenticatedAgent
        .put(`/api/sources/test-source/meshcore/contacts/${VALID_PUBKEY}/out-path`)
        .send({ outPath: 'a3f2,7f01', hashBytes: 2 });
      expect(response.status).toBe(200);
      const [, bytes, hashBytes] = meshcoreManager.setContactOutPath.mock.calls[0];
      expect(Array.from(bytes)).toEqual([0xa3, 0xf2, 0x7f, 0x01]);
      expect(hashBytes).toBe(2);
    });

    it('rejects a hop token whose width does not match hashBytes', async () => {
      const response = await authenticatedAgent
        .put(`/api/sources/test-source/meshcore/contacts/${VALID_PUBKEY}/out-path`)
        .send({ outPath: 'a3,7f', hashBytes: 2 }); // 1-byte tokens under a 2-byte width
      expect(response.status).toBe(400);
      expect(meshcoreManager.setContactOutPath).not.toHaveBeenCalled();
    });

    it('rejects an invalid hashBytes value', async () => {
      const response = await authenticatedAgent
        .put(`/api/sources/test-source/meshcore/contacts/${VALID_PUBKEY}/out-path`)
        .send({ outPath: 'a3', hashBytes: 4 });
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/hashBytes/);
      expect(meshcoreManager.setContactOutPath).not.toHaveBeenCalled();
    });

    it('accepts an empty path as zero-hop direct', async () => {
      const response = await authenticatedAgent
        .put(`/api/sources/test-source/meshcore/contacts/${VALID_PUBKEY}/out-path`)
        .send({ outPath: '' });
      expect(response.status).toBe(200);
      const bytes = meshcoreManager.setContactOutPath.mock.calls[0][1];
      expect(Array.from(bytes)).toEqual([]);
    });

    it('returns 409 when the manager rejects', async () => {
      meshcoreManager.setContactOutPath.mockResolvedValueOnce(false);
      const response = await authenticatedAgent
        .put(`/api/sources/test-source/meshcore/contacts/${VALID_PUBKEY}/out-path`)
        .send({ outPath: 'a3' });
      expect(response.status).toBe(409);
    });
  });

  /**
   * Audit log entries are written via `auditLogAsync(userId, action,
   * resource, JSON details, ip)`. These tests assert the right event
   * fires on the right code path and — for the login routes — that the
   * password never appears in the JSON details.
   */
  describe('Audit log entries', () => {
    const validKey = 'a'.repeat(64);
    const SENSITIVE = 'super-secret-password-must-never-be-audited';

    /** Look up the most recent call to auditLogAsync; return parsed details. */
    function lastAudit(): { userId: unknown; action: string; resource: string; details: any; ip: unknown } | null {
      const mock = (DatabaseService as any).auditLogAsync as ReturnType<typeof vi.fn>;
      const calls = mock.mock.calls;
      if (calls.length === 0) return null;
      const [userId, action, resource, detailsJson, ip] = calls[calls.length - 1] as [unknown, string, string, string, unknown];
      return { userId, action, resource, details: JSON.parse(detailsJson), ip };
    }

    beforeEach(() => {
      ((DatabaseService as any).auditLogAsync as ReturnType<typeof vi.fn>).mockClear();
      meshcoreManager.loginToNode.mockReset();
      meshcoreManager.loginToNode.mockResolvedValue(true);
      meshcoreManager.sendCliCommand.mockReset();
      meshcoreManager.sendCliCommand.mockResolvedValue({ reply: 'pong', elapsedMs: 11 });
      meshcoreManager.sendLocalCliCommand.mockReset();
      meshcoreManager.sendLocalCliCommand.mockResolvedValue({ reply: 'v1.7.0', elapsedMs: 9 });
      fakeCredentialStore.load.mockReset();
      fakeCredentialStore.clear.mockReset();
      fakeCredentialStore.clear.mockResolvedValue(undefined);
    });

    it('logs meshcore_remote_login on /admin/login success (no password in details)', async () => {
      await authenticatedAgent
        .post('/api/sources/test-source/meshcore/admin/login')
        .send({ publicKey: validKey, password: SENSITIVE });
      const entry = lastAudit();
      expect(entry?.action).toBe('meshcore_remote_login');
      expect(entry?.resource).toBe('remote_admin');
      expect(entry?.details).toMatchObject({ sourceId: 'test-source', publicKey: validKey, persisted: false });
      const raw = JSON.stringify(entry);
      expect(raw).not.toContain(SENSITIVE);
    });

    it('logs meshcore_remote_login_failed on /admin/login auth failure (no password in details)', async () => {
      meshcoreManager.loginToNode.mockResolvedValue(false);
      await authenticatedAgent
        .post('/api/sources/test-source/meshcore/admin/login')
        .send({ publicKey: validKey, password: SENSITIVE });
      const entry = lastAudit();
      expect(entry?.action).toBe('meshcore_remote_login_failed');
      expect(JSON.stringify(entry)).not.toContain(SENSITIVE);
    });

    it('records persisted=true in the audit row when rememberPassword=true (still no password)', async () => {
      fakeCredentialStore.capability = { canRemember: true, reason: undefined };
      fakeCredentialStore.store.mockReset();
      fakeCredentialStore.store.mockResolvedValue(undefined);
      await authenticatedAgent
        .post('/api/sources/test-source/meshcore/admin/login')
        .send({ publicKey: validKey, password: SENSITIVE, rememberPassword: true });
      const entry = lastAudit();
      expect(entry?.action).toBe('meshcore_remote_login');
      expect(entry?.details.persisted).toBe(true);
      expect(JSON.stringify(entry)).not.toContain(SENSITIVE);
    });

    it('logs meshcore_remote_cli on /admin/cli success including command + elapsedMs', async () => {
      await authenticatedAgent
        .post('/api/sources/test-source/meshcore/admin/cli')
        .send({ publicKey: validKey, command: 'ver' });
      const entry = lastAudit();
      expect(entry?.action).toBe('meshcore_remote_cli');
      expect(entry?.details).toMatchObject({
        sourceId: 'test-source',
        publicKey: validKey,
        command: 'ver',
        replyChars: 4,
        elapsedMs: 11,
      });
    });

    it('logs meshcore_remote_cli_blocked when a danger command is rejected', async () => {
      await authenticatedAgent
        .post('/api/sources/test-source/meshcore/admin/cli')
        .send({ publicKey: validKey, command: 'reboot' });
      const entry = lastAudit();
      expect(entry?.action).toBe('meshcore_remote_cli_blocked');
      expect(entry?.details.reason).toBe('DANGER_CONFIRM_REQUIRED');
    });

    it('logs meshcore_remote_cli_failed when the manager throws', async () => {
      meshcoreManager.sendCliCommand.mockRejectedValueOnce(new Error('CLI command timed out after 15000ms'));
      await authenticatedAgent
        .post('/api/sources/test-source/meshcore/admin/cli')
        .send({ publicKey: validKey, command: 'stats' });
      const entry = lastAudit();
      expect(entry?.action).toBe('meshcore_remote_cli_failed');
      expect(entry?.details.error).toContain('timed out');
    });

    it('logs meshcore_local_cli on /cli success', async () => {
      await authenticatedAgent
        .post('/api/sources/test-source/meshcore/cli')
        .send({ command: 'ver' });
      const entry = lastAudit();
      expect(entry?.action).toBe('meshcore_local_cli');
      expect(entry?.resource).toBe('configuration');
      expect(entry?.details).toMatchObject({ sourceId: 'test-source', command: 'ver' });
    });

    it('logs meshcore_remote_login_saved on auto-login success (no password in details)', async () => {
      fakeCredentialStore.load.mockResolvedValue({ kind: 'ok', password: SENSITIVE });
      await authenticatedAgent
        .post('/api/sources/test-source/meshcore/admin/login-with-saved')
        .send({ publicKey: validKey });
      const entry = lastAudit();
      expect(entry?.action).toBe('meshcore_remote_login_saved');
      expect(JSON.stringify(entry)).not.toContain(SENSITIVE);
    });

    it('logs meshcore_remote_login_saved_failed with the code on key rotation', async () => {
      fakeCredentialStore.load.mockResolvedValue({ kind: 'key_rotated', storedKid: 'deadbeef' });
      await authenticatedAgent
        .post('/api/sources/test-source/meshcore/admin/login-with-saved')
        .send({ publicKey: validKey });
      const entry = lastAudit();
      expect(entry?.action).toBe('meshcore_remote_login_saved_failed');
      expect(entry?.details.code).toBe('CREDENTIAL_KEY_ROTATED');
    });

    it('logs meshcore_credential_forget on DELETE /admin/credentials/:publicKey', async () => {
      await authenticatedAgent.delete(`/api/sources/test-source/meshcore/admin/credentials/${validKey}`);
      const entry = lastAudit();
      expect(entry?.action).toBe('meshcore_credential_forget');
      expect(entry?.details).toMatchObject({ sourceId: 'test-source', publicKey: validKey });
    });

    /**
     * Canary: across EVERY audit-emitting code path, the plaintext password
     * must never appear in the JSON details. This is the test that catches
     * "someone accidentally spread req.body into the details object."
     */
    it('NEVER includes the password in any audit details', async () => {
      // login success
      await authenticatedAgent
        .post('/api/sources/test-source/meshcore/admin/login')
        .send({ publicKey: validKey, password: SENSITIVE });
      // login failure
      meshcoreManager.loginToNode.mockResolvedValueOnce(false);
      await authenticatedAgent
        .post('/api/sources/test-source/meshcore/admin/login')
        .send({ publicKey: validKey, password: SENSITIVE });
      // login-with-saved success — credential store decrypts SENSITIVE
      fakeCredentialStore.load.mockResolvedValueOnce({ kind: 'ok', password: SENSITIVE });
      await authenticatedAgent
        .post('/api/sources/test-source/meshcore/admin/login-with-saved')
        .send({ publicKey: validKey });
      // login-with-saved remote-reject — credential decrypts but loginToNode says no
      fakeCredentialStore.load.mockResolvedValueOnce({ kind: 'ok', password: SENSITIVE });
      meshcoreManager.loginToNode.mockResolvedValueOnce(false);
      await authenticatedAgent
        .post('/api/sources/test-source/meshcore/admin/login-with-saved')
        .send({ publicKey: validKey });

      const mock = (DatabaseService as any).auditLogAsync as ReturnType<typeof vi.fn>;
      for (const call of mock.mock.calls) {
        // call = [userId, action, resource, detailsJson, ip]
        expect(call[3]).not.toContain(SENSITIVE);
      }
    });
  });

  // Coverage for the private-key import/export endpoints (#3301). meshcore.js
  // exports Ed25519 *expanded* keys (64 bytes = 128 hex chars), so validation
  // must accept 128 hex chars — not 64.
  describe('Private Key Management (/config/private-key)', () => {
    const VALID_KEY = 'a'.repeat(128); // 128 hex chars = 64-byte expanded key

    describe('POST (import)', () => {
      it('requires authentication', async () => {
        const response = await request(app)
          .post('/api/sources/test-source/meshcore/config/private-key')
          .send({ privateKey: VALID_KEY, confirm: true });
        expect(response.status).toBe(401);
      });

      it('requires confirm:true (destructive identity replace)', async () => {
        const response = await authenticatedAgent
          .post('/api/sources/test-source/meshcore/config/private-key')
          .send({ privateKey: VALID_KEY });
        expect(response.status).toBe(400);
        expect(response.body.code).toBe('DANGER_CONFIRM_REQUIRED');
        expect(meshcoreManager.importPrivateKey).not.toHaveBeenCalled();
      });

      it('rejects keys shorter than 128 hex chars', async () => {
        const response = await authenticatedAgent
          .post('/api/sources/test-source/meshcore/config/private-key')
          .send({ privateKey: 'a'.repeat(64), confirm: true }); // 64 hex = old (wrong) length
        expect(response.status).toBe(400);
        expect(response.body.error).toMatch(/128-character hex string/);
        expect(meshcoreManager.importPrivateKey).not.toHaveBeenCalled();
      });

      it('rejects keys with invalid hex characters', async () => {
        const response = await authenticatedAgent
          .post('/api/sources/test-source/meshcore/config/private-key')
          .send({ privateKey: 'g'.repeat(128), confirm: true });
        expect(response.status).toBe(400);
        expect(response.body.error).toMatch(/128-character hex string/);
        expect(meshcoreManager.importPrivateKey).not.toHaveBeenCalled();
      });

      it('accepts a valid 128-char hex key', async () => {
        meshcoreManager.importPrivateKey.mockResolvedValueOnce(true);
        const response = await authenticatedAgent
          .post('/api/sources/test-source/meshcore/config/private-key')
          .send({ privateKey: VALID_KEY, confirm: true });
        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(meshcoreManager.importPrivateKey).toHaveBeenCalledWith(VALID_KEY);
      });

      it('returns 409 when the device rejects the import', async () => {
        meshcoreManager.importPrivateKey.mockResolvedValueOnce(false);
        const response = await authenticatedAgent
          .post('/api/sources/test-source/meshcore/config/private-key')
          .send({ privateKey: VALID_KEY, confirm: true });
        expect(response.status).toBe(409);
        expect(response.body.success).toBe(false);
      });
    });

    describe('GET (export)', () => {
      it('requires authentication', async () => {
        const response = await request(app).get(
          '/api/sources/test-source/meshcore/config/private-key',
        );
        expect(response.status).toBe(401);
      });

      it('returns the exported 128-char hex key', async () => {
        meshcoreManager.exportPrivateKey.mockResolvedValueOnce(VALID_KEY);
        const response = await authenticatedAgent.get(
          '/api/sources/test-source/meshcore/config/private-key',
        );
        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.data.privateKey).toBe(VALID_KEY);
      });

      it('returns 409 when export is unavailable (disconnected / non-Companion)', async () => {
        meshcoreManager.exportPrivateKey.mockResolvedValueOnce(null);
        const response = await authenticatedAgent.get(
          '/api/sources/test-source/meshcore/config/private-key',
        );
        expect(response.status).toBe(409);
        expect(response.body.success).toBe(false);
      });
    });
  });

  describe('GET /api/sources/test-source/meshcore/packets (list)', () => {
    const samplePackets = [
      { id: 2, sourceId: 'test-source', timestamp: 1700000002000, payloadType: 1, routeType: 0, rawHex: 'beef' },
      { id: 1, sourceId: 'test-source', timestamp: 1700000001000, payloadType: 2, routeType: 1, rawHex: 'cafe' },
    ];

    beforeEach(() => {
      mockPacketService.getPackets.mockResolvedValue(samplePackets);
      mockPacketService.getPacketCount.mockResolvedValue(samplePackets.length);
      mockPacketService.isEnabled.mockResolvedValue(true);
      mockPacketService.getMaxAgeHours.mockResolvedValue(24);
      mockPacketService.getMaxCount.mockResolvedValue(1000);
    });

    it('honors meshcore_packet_log_max_count as the default query limit (#3690)', async () => {
      // The user has configured a max count of 500. With no explicit ?limit,
      // the list endpoint must query up to 500 rows — not the old hard-coded 100.
      mockPacketService.getMaxCount.mockResolvedValue(500);

      const response = await authenticatedAgent.get('/api/sources/test-source/meshcore/packets');

      expect(response.status).toBe(200);
      expect(response.body.maxCount).toBe(500);
      expect(mockPacketService.getPackets).toHaveBeenCalledWith(
        expect.objectContaining({ sourceId: 'test-source', offset: 0, limit: 500 }),
      );
      expect(response.body.limit).toBe(500);
    });

    it('clamps the configured max count to the hard ceiling (1000)', async () => {
      mockPacketService.getMaxCount.mockResolvedValue(5000);

      const response = await authenticatedAgent.get('/api/sources/test-source/meshcore/packets');

      expect(response.status).toBe(200);
      expect(mockPacketService.getPackets).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 1000 }),
      );
    });

    it('honors an explicit smaller client-supplied limit', async () => {
      mockPacketService.getMaxCount.mockResolvedValue(500);

      const response = await authenticatedAgent.get('/api/sources/test-source/meshcore/packets?limit=50');

      expect(response.status).toBe(200);
      expect(mockPacketService.getPackets).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 50 }),
      );
      expect(response.body.limit).toBe(50);
    });
  });

  describe('GET /api/sources/test-source/meshcore/packets/export', () => {
    const samplePackets = [
      { id: 2, sourceId: 'test-source', timestamp: 1700000002000, payloadType: 1, routeType: 0, rawHex: 'beef' },
      { id: 1, sourceId: 'test-source', timestamp: 1700000001000, payloadType: 2, routeType: 1, rawHex: 'cafe' },
    ];

    beforeEach(() => {
      mockPacketService.getMaxCount.mockResolvedValue(1000);
      mockPacketService.getPackets.mockResolvedValue(samplePackets);
    });

    it('exports packets as JSONL with attachment headers', async () => {
      const response = await authenticatedAgent.get('/api/sources/test-source/meshcore/packets/export');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('application/x-ndjson');
      expect(response.headers['content-disposition']).toMatch(/attachment; filename="meshcore-packet-monitor-.*\.jsonl"/);

      const lines = response.text.trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0])).toMatchObject({ id: 2, payloadType: 1 });
      expect(JSON.parse(lines[1])).toMatchObject({ id: 1, payloadType: 2 });

      // Exports up to the retention cap, scoped to this source, offset 0.
      expect(mockPacketService.getPackets).toHaveBeenCalledWith(
        expect.objectContaining({ sourceId: 'test-source', offset: 0, limit: 1000 }),
      );
    });

    it('passes filters through and marks the filename as filtered', async () => {
      const response = await authenticatedAgent.get(
        '/api/sources/test-source/meshcore/packets/export?payload_type=1&route_type=0',
      );

      expect(response.status).toBe(200);
      expect(response.headers['content-disposition']).toMatch(/meshcore-packet-monitor-filtered-/);
      expect(mockPacketService.getPackets).toHaveBeenCalledWith(
        expect.objectContaining({ payloadType: 1, routeType: 0 }),
      );
    });

    it('returns 404 for an unregistered source', async () => {
      const response = await authenticatedAgent.get('/api/sources/does-not-exist/meshcore/packets/export');
      expect(response.status).toBe(404);
    });
  });
});
