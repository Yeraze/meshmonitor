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
  getAllNodes: vi.fn().mockReturnValue([]),
  getContacts: vi.fn().mockReturnValue([]),
  getContact: vi.fn().mockReturnValue(undefined),
  getRecentMessages: vi.fn().mockReturnValue([]),
  connect: vi.fn().mockResolvedValue(true),
  disconnect: vi.fn().mockResolvedValue(undefined),
  sendMessage: vi.fn().mockResolvedValue(true),
  sendAdvert: vi.fn().mockResolvedValue(true),
  refreshContacts: vi.fn().mockResolvedValue(new Map()),
  resetContactPath: vi.fn().mockResolvedValue(true),
  discoverContactPath: vi.fn().mockResolvedValue(true),
  shareContact: vi.fn().mockResolvedValue(true),
  setContactOutPath: vi.fn().mockResolvedValue(true),
  loginToNode: vi.fn().mockResolvedValue(true),
  requestNodeStatus: vi.fn().mockResolvedValue({ batteryMv: 4200, uptimeSecs: 3600 }),
  sendCliCommand: vi.fn().mockResolvedValue({ reply: 'ok', elapsedMs: 42 }),
  sendLocalCliCommand: vi.fn().mockResolvedValue({ reply: 'v1.7.0', elapsedMs: 12 }),
  setName: vi.fn().mockResolvedValue(true),
  setRadio: vi.fn().mockResolvedValue(true),
  importPrivateKey: vi.fn().mockResolvedValue(true),
  exportPrivateKey: vi.fn().mockResolvedValue('a'.repeat(128)),
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

import DatabaseService from '../../services/database.js';

// Mutable holder so individual tests can flip the toggle for the
// feature-flag-gated out-path route.
const globalSettingsMock = {
  meshcoreAdvancedPathEdit: 'false' as string | boolean | null,
};
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
    // Spy on auditLogAsync so tests can assert specific routes fired the
    // expected event. Returns a resolved promise so the fire-and-forget
    // .catch() in the route helper has something to chain.
    (DatabaseService as any).auditLogAsync = vi.fn(async () => undefined);
    (DatabaseService as any).drizzleDbType = 'sqlite';

    // The out-path PUT route reads the advanced-path-edit toggle from
    // global settings. Default the mock to "off" so tests opt-in to the
    // "feature flag enabled" branch.
    (DatabaseService as any).settings = {
      getSetting: vi.fn(async (key: string) => {
        if (key === 'meshcoreAdvancedPathEdit') return globalSettingsMock.meshcoreAdvancedPathEdit;
        return null;
      }),
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
    for (const resource of ['connection', 'nodes', 'messages', 'configuration', 'remote_admin'] as const) {
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

    for (const resource of ['connection', 'nodes', 'messages', 'configuration', 'remote_admin'] as const) {
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

  describe('POST /api/sources/test-source/meshcore/contacts/:publicKey/share', () => {
    const VALID_PUBKEY = 'b'.repeat(64);

    beforeEach(() => {
      meshcoreManager.shareContact.mockReset();
      meshcoreManager.shareContact.mockResolvedValue(true);
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

    it('returns 409 when the manager rejects (unknown contact / non-companion)', async () => {
      meshcoreManager.shareContact.mockResolvedValueOnce(false);
      const response = await authenticatedAgent
        .post(`/api/sources/test-source/meshcore/contacts/${VALID_PUBKEY}/share`);
      expect(response.status).toBe(409);
      expect(response.body.success).toBe(false);
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
      globalSettingsMock.meshcoreAdvancedPathEdit = 'false';
    });

    it('requires authentication', async () => {
      const response = await request(app)
        .put(`/api/sources/test-source/meshcore/contacts/${VALID_PUBKEY}/out-path`)
        .send({ outPath: 'a3,7f,02' });
      expect(response.status).toBe(401);
    });

    it('returns 403 when the advanced toggle is off', async () => {
      globalSettingsMock.meshcoreAdvancedPathEdit = 'false';
      const response = await authenticatedAgent
        .put(`/api/sources/test-source/meshcore/contacts/${VALID_PUBKEY}/out-path`)
        .send({ outPath: 'a3,7f,02' });
      expect(response.status).toBe(403);
      expect(response.body.error).toMatch(/meshcoreAdvancedPathEdit/);
      expect(meshcoreManager.setContactOutPath).not.toHaveBeenCalled();
    });

    it('rejects an invalid public key (regardless of toggle)', async () => {
      globalSettingsMock.meshcoreAdvancedPathEdit = 'true';
      const response = await authenticatedAgent
        .put('/api/sources/test-source/meshcore/contacts/not-hex/out-path')
        .send({ outPath: 'a3,7f,02' });
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/64-char hex/);
      expect(meshcoreManager.setContactOutPath).not.toHaveBeenCalled();
    });

    it('rejects a malformed hex chain', async () => {
      globalSettingsMock.meshcoreAdvancedPathEdit = 'true';
      const response = await authenticatedAgent
        .put(`/api/sources/test-source/meshcore/contacts/${VALID_PUBKEY}/out-path`)
        .send({ outPath: 'a3,nothex,02' });
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/comma-separated hex/);
      expect(meshcoreManager.setContactOutPath).not.toHaveBeenCalled();
    });

    it('rejects an oversize path (>64 hops)', async () => {
      globalSettingsMock.meshcoreAdvancedPathEdit = 'true';
      const oversized = Array(65).fill('aa').join(',');
      const response = await authenticatedAgent
        .put(`/api/sources/test-source/meshcore/contacts/${VALID_PUBKEY}/out-path`)
        .send({ outPath: oversized });
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/too long/);
      expect(meshcoreManager.setContactOutPath).not.toHaveBeenCalled();
    });

    it('forwards valid path bytes to the manager and returns 200', async () => {
      globalSettingsMock.meshcoreAdvancedPathEdit = 'true';
      const response = await authenticatedAgent
        .put(`/api/sources/test-source/meshcore/contacts/${VALID_PUBKEY}/out-path`)
        .send({ outPath: 'a3,7f,02' });
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(meshcoreManager.setContactOutPath).toHaveBeenCalledTimes(1);
      const [pk, bytes] = meshcoreManager.setContactOutPath.mock.calls[0];
      expect(pk).toBe(VALID_PUBKEY);
      expect(Array.from(bytes)).toEqual([0xa3, 0x7f, 0x02]);
    });

    it('accepts an empty path as zero-hop direct', async () => {
      globalSettingsMock.meshcoreAdvancedPathEdit = 'true';
      const response = await authenticatedAgent
        .put(`/api/sources/test-source/meshcore/contacts/${VALID_PUBKEY}/out-path`)
        .send({ outPath: '' });
      expect(response.status).toBe(200);
      const bytes = meshcoreManager.setContactOutPath.mock.calls[0][1];
      expect(Array.from(bytes)).toEqual([]);
    });

    it('returns 409 when the manager rejects', async () => {
      globalSettingsMock.meshcoreAdvancedPathEdit = 'true';
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
});
