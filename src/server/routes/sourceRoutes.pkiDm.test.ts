/**
 * Tests for the per-source PKI DM decryption routes (issue #3441):
 *   GET  /api/sources/:id/pki-dm/status
 *   POST /api/sources/:id/pki-dm
 * Focus: source-scoped `configuration` permission gating, enable/disable
 * side-effects (set setting, clear key on disable), and the MeshCore 400.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { Express } from 'express';
import session from 'express-session';
import request from 'supertest';
import sourceRoutes from './sourceRoutes.js';
import databaseService from '../../services/database.js';

vi.mock('../../services/database.js', () => ({
  default: {
    sources: { getSource: vi.fn(), getAllSources: vi.fn().mockResolvedValue([]) },
    settings: {
      getSettingForSource: vi.fn().mockResolvedValue(null),
      setSourceSetting: vi.fn().mockResolvedValue(undefined),
    },
    checkPermissionAsync: vi.fn().mockResolvedValue(true),
    findUserByIdAsync: vi.fn(),
    findUserByUsernameAsync: vi.fn().mockResolvedValue(null),
    getUserPermissionSetAsync: vi.fn().mockResolvedValue({ resources: {}, isAdmin: true }),
    getChannelDatabasePermissionsForUserAsSetAsync: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: { getManager: vi.fn().mockReturnValue(null) },
}));
vi.mock('../mqttBridgeManager.js', () => ({ MqttBridgeManager: class {} }));
vi.mock('../mqttBrokerManager.js', () => ({ MqttBrokerManager: class {} }));

const fakeStore = {
  capability: { canStore: true as boolean, reason: undefined as string | undefined },
  hasStored: vi.fn(async () => false),
  clear: vi.fn(async () => undefined),
};
vi.mock('../services/sourcePkiKeyStore.js', () => ({
  getSourcePkiKeyStore: () => fakeStore,
}));

const mockDb = databaseService as any;
const adminUser = { id: 1, username: 'admin', isActive: true, isAdmin: true };
const regularUser = { id: 2, username: 'user', isActive: true, isAdmin: false };

const createApp = (user: any): Express => {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false, cookie: { secure: false } }));
  app.use((req: any, _res, next) => { req.session.userId = user.id; next(); });
  app.use('/', sourceRoutes);
  return app;
};

const TCP_SOURCE = { id: 'src-tcp', name: 'Sandbox', type: 'meshtastic_tcp', enabled: true, config: {}, createdAt: 0, updatedAt: 0, createdBy: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.findUserByIdAsync.mockImplementation(async (id: number) => (id === 1 ? adminUser : regularUser));
  mockDb.checkPermissionAsync.mockResolvedValue(true);
  fakeStore.capability = { canStore: true, reason: undefined };
  fakeStore.hasStored.mockResolvedValue(false);
});

describe('GET /api/sources/:id/pki-dm/status', () => {
  it('reports enabled + keyStored', async () => {
    mockDb.sources.getSource.mockResolvedValue(TCP_SOURCE);
    mockDb.settings.getSettingForSource.mockResolvedValue('true');
    fakeStore.hasStored.mockResolvedValue(true);

    const res = await request(createApp(adminUser)).get('/src-tcp/pki-dm/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, keyStored: true, canStore: true });
  });

  it('404s for an unknown source', async () => {
    mockDb.sources.getSource.mockResolvedValue(null);
    const res = await request(createApp(adminUser)).get('/nope/pki-dm/status');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/sources/:id/pki-dm', () => {
  it('enables and persists the per-source setting', async () => {
    mockDb.sources.getSource.mockResolvedValue(TCP_SOURCE);
    const res = await request(createApp(adminUser)).post('/src-tcp/pki-dm').send({ enabled: true });
    expect(res.status).toBe(200);
    expect(mockDb.settings.setSourceSetting).toHaveBeenCalledWith('src-tcp', 'pkiDmDecryptionEnabled', 'true');
    expect(fakeStore.clear).not.toHaveBeenCalled();
  });

  it('disabling forgets the stored key', async () => {
    mockDb.sources.getSource.mockResolvedValue(TCP_SOURCE);
    const res = await request(createApp(adminUser)).post('/src-tcp/pki-dm').send({ enabled: false });
    expect(res.status).toBe(200);
    expect(mockDb.settings.setSourceSetting).toHaveBeenCalledWith('src-tcp', 'pkiDmDecryptionEnabled', 'false');
    expect(fakeStore.clear).toHaveBeenCalledWith('src-tcp');
  });

  it('rejects enabling when SESSION_SECRET is unavailable', async () => {
    mockDb.sources.getSource.mockResolvedValue(TCP_SOURCE);
    fakeStore.capability = { canStore: false, reason: 'no secret' };
    const res = await request(createApp(adminUser)).post('/src-tcp/pki-dm').send({ enabled: true });
    expect(res.status).toBe(400);
    expect(mockDb.settings.setSourceSetting).not.toHaveBeenCalled();
  });

  it('400s for a MeshCore source', async () => {
    mockDb.sources.getSource.mockResolvedValue({ ...TCP_SOURCE, id: 'mc', type: 'meshcore' });
    const res = await request(createApp(adminUser)).post('/mc/pki-dm').send({ enabled: true });
    expect(res.status).toBe(400);
  });

  it('403s without per-source configuration:write permission', async () => {
    mockDb.sources.getSource.mockResolvedValue(TCP_SOURCE);
    mockDb.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: false });
    mockDb.checkPermissionAsync.mockResolvedValue(false);
    const res = await request(createApp(regularUser)).post('/src-tcp/pki-dm').send({ enabled: true });
    expect(res.status).toBe(403);
    expect(mockDb.settings.setSourceSetting).not.toHaveBeenCalled();
  });
});
