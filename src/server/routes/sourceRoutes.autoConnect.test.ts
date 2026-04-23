/**
 * Source Routes — autoConnect / manual connect tests (issue #2773)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { Express } from 'express';
import session from 'express-session';
import request from 'supertest';
import sourceRoutes from './sourceRoutes.js';
import databaseService from '../../services/database.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';

vi.mock('../../services/database.js', () => ({
  default: {
    sources: {
      getSource: vi.fn(),
      getAllSources: vi.fn().mockResolvedValue([]),
      createSource: vi.fn(),
      updateSource: vi.fn(),
    },
    nodes: {
      getAllNodes: vi.fn().mockResolvedValue([]),
      getNodesByNums: vi.fn().mockResolvedValue(new Map()),
    },
    messages: { getMessages: vi.fn().mockResolvedValue([]) },
    traceroutes: { getAllTraceroutes: vi.fn().mockResolvedValue([]) },
    neighbors: { getAllNeighborInfo: vi.fn().mockResolvedValue([]) },
    channels: { getAllChannels: vi.fn().mockResolvedValue([]) },
    settings: { getSetting: vi.fn().mockResolvedValue(null) },
    checkPermissionAsync: vi.fn().mockResolvedValue(true),
    findUserByIdAsync: vi.fn(),
    findUserByUsernameAsync: vi.fn().mockResolvedValue(null),
    getUserPermissionSetAsync: vi.fn().mockResolvedValue({ resources: {}, isAdmin: true }),
    getChannelDatabasePermissionsForUserAsSetAsync: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn().mockReturnValue(null),
    addManager: vi.fn().mockResolvedValue(undefined),
    removeManager: vi.fn().mockResolvedValue(undefined),
    reconfigureVirtualNode: vi.fn().mockResolvedValue(false),
  },
}));

vi.mock('../meshtasticManager.js', () => {
  class MeshtasticManager {
    sourceId: string;
    constructor(sourceId: string) {
      this.sourceId = sourceId;
    }
    async start() {}
    async stop() {}
    getStatus() {
      return { sourceId: this.sourceId, sourceName: '', sourceType: 'meshtastic_tcp' as const, connected: false };
    }
    getLocalNodeInfo() { return null; }
  }
  return { MeshtasticManager };
});

const mockDb = databaseService as any;
const mockRegistry = sourceManagerRegistry as any;

const adminUser = { id: 1, username: 'admin', isActive: true, isAdmin: true };

const createApp = (): Express => {
  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
      cookie: { secure: false },
    })
  );
  app.use((req: any, _res, next) => {
    req.session.userId = adminUser.id;
    next();
  });
  app.use('/', sourceRoutes);
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.findUserByIdAsync.mockResolvedValue(adminUser);
  mockDb.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: true });
  mockDb.checkPermissionAsync.mockResolvedValue(true);
  mockRegistry.getManager.mockReturnValue(null);
});

describe('sourceRoutes — autoConnect flag on create', () => {
  it('does not start a manager when autoConnect is false', async () => {
    const app = createApp();
    mockDb.sources.createSource.mockResolvedValue({
      id: 'new-id',
      name: 'Test',
      type: 'meshtastic_tcp',
      enabled: true,
      config: { host: '1.2.3.4', port: 4403, autoConnect: false },
      createdAt: 0,
      updatedAt: 0,
      createdBy: 1,
    });

    const res = await request(app)
      .post('/')
      .send({
        name: 'Test',
        type: 'meshtastic_tcp',
        config: { host: '1.2.3.4', port: 4403, autoConnect: false },
      });

    expect(res.status).toBe(201);
    expect(mockRegistry.addManager).not.toHaveBeenCalled();
  });

  it('starts a manager when autoConnect is true (default)', async () => {
    const app = createApp();
    mockDb.sources.createSource.mockResolvedValue({
      id: 'new-id',
      name: 'Test',
      type: 'meshtastic_tcp',
      enabled: true,
      config: { host: '1.2.3.4', port: 4403, autoConnect: true },
      createdAt: 0,
      updatedAt: 0,
      createdBy: 1,
    });

    const res = await request(app)
      .post('/')
      .send({
        name: 'Test',
        type: 'meshtastic_tcp',
        config: { host: '1.2.3.4', port: 4403, autoConnect: true },
      });

    expect(res.status).toBe(201);
    expect(mockRegistry.addManager).toHaveBeenCalledTimes(1);
  });
});

describe('sourceRoutes — POST /:id/connect (manual connect)', () => {
  it('starts the manager when source is enabled and no manager exists', async () => {
    const app = createApp();
    mockDb.sources.getSource.mockResolvedValue({
      id: 'src-1',
      name: 'Test',
      type: 'meshtastic_tcp',
      enabled: true,
      config: { host: '1.2.3.4', port: 4403, autoConnect: false },
      createdAt: 0,
      updatedAt: 0,
      createdBy: 1,
    });

    const res = await request(app).post('/src-1/connect');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(mockRegistry.addManager).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — reports alreadyRunning when manager already active', async () => {
    const app = createApp();
    mockDb.sources.getSource.mockResolvedValue({
      id: 'src-1',
      name: 'Test',
      type: 'meshtastic_tcp',
      enabled: true,
      config: { host: '1.2.3.4', port: 4403, autoConnect: false },
      createdAt: 0,
      updatedAt: 0,
      createdBy: 1,
    });
    mockRegistry.getManager.mockReturnValue({ sourceId: 'src-1' });

    const res = await request(app).post('/src-1/connect');

    expect(res.status).toBe(200);
    expect(res.body.alreadyRunning).toBe(true);
    expect(mockRegistry.addManager).not.toHaveBeenCalled();
  });

  it('rejects when source is disabled', async () => {
    const app = createApp();
    mockDb.sources.getSource.mockResolvedValue({
      id: 'src-1',
      name: 'Test',
      type: 'meshtastic_tcp',
      enabled: false,
      config: { host: '1.2.3.4', port: 4403, autoConnect: false },
      createdAt: 0,
      updatedAt: 0,
      createdBy: 1,
    });

    const res = await request(app).post('/src-1/connect');

    expect(res.status).toBe(409);
    expect(mockRegistry.addManager).not.toHaveBeenCalled();
  });

  it('returns 404 when source does not exist', async () => {
    const app = createApp();
    mockDb.sources.getSource.mockResolvedValue(null);

    const res = await request(app).post('/missing/connect');

    expect(res.status).toBe(404);
  });
});

describe('sourceRoutes — POST /:id/disconnect', () => {
  it('stops a running manager', async () => {
    const app = createApp();
    mockDb.sources.getSource.mockResolvedValue({
      id: 'src-1',
      name: 'Test',
      type: 'meshtastic_tcp',
      enabled: true,
      config: { host: '1.2.3.4', port: 4403 },
      createdAt: 0,
      updatedAt: 0,
      createdBy: 1,
    });
    mockRegistry.getManager.mockReturnValue({ sourceId: 'src-1' });

    const res = await request(app).post('/src-1/disconnect');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(mockRegistry.removeManager).toHaveBeenCalledWith('src-1');
  });

  it('is idempotent — reports alreadyStopped when nothing running', async () => {
    const app = createApp();
    mockDb.sources.getSource.mockResolvedValue({
      id: 'src-1',
      name: 'Test',
      type: 'meshtastic_tcp',
      enabled: true,
      config: { host: '1.2.3.4', port: 4403 },
      createdAt: 0,
      updatedAt: 0,
      createdBy: 1,
    });
    mockRegistry.getManager.mockReturnValue(null);

    const res = await request(app).post('/src-1/disconnect');

    expect(res.status).toBe(200);
    expect(res.body.alreadyStopped).toBe(true);
    expect(mockRegistry.removeManager).not.toHaveBeenCalled();
  });
});

describe('sourceRoutes — autoConnect transitions on PUT', () => {
  it('stops the manager when autoConnect flips from true to false', async () => {
    const app = createApp();
    mockDb.sources.getSource.mockResolvedValue({
      id: 'src-1',
      name: 'Old',
      type: 'meshtastic_tcp',
      enabled: true,
      config: { host: '1.2.3.4', port: 4403, autoConnect: true },
      createdAt: 0,
      updatedAt: 0,
      createdBy: 1,
    });
    mockDb.sources.updateSource.mockResolvedValue({
      id: 'src-1',
      name: 'Old',
      type: 'meshtastic_tcp',
      enabled: true,
      config: { host: '1.2.3.4', port: 4403, autoConnect: false },
      createdAt: 0,
      updatedAt: 0,
      createdBy: 1,
    });

    const res = await request(app)
      .put('/src-1')
      .send({ config: { host: '1.2.3.4', port: 4403, autoConnect: false } });

    expect(res.status).toBe(200);
    expect(mockRegistry.removeManager).toHaveBeenCalledWith('src-1');
    expect(mockRegistry.addManager).not.toHaveBeenCalled();
  });

  it('starts the manager when autoConnect flips from false to true', async () => {
    const app = createApp();
    mockDb.sources.getSource.mockResolvedValue({
      id: 'src-1',
      name: 'Old',
      type: 'meshtastic_tcp',
      enabled: true,
      config: { host: '1.2.3.4', port: 4403, autoConnect: false },
      createdAt: 0,
      updatedAt: 0,
      createdBy: 1,
    });
    mockDb.sources.updateSource.mockResolvedValue({
      id: 'src-1',
      name: 'Old',
      type: 'meshtastic_tcp',
      enabled: true,
      config: { host: '1.2.3.4', port: 4403, autoConnect: true },
      createdAt: 0,
      updatedAt: 0,
      createdBy: 1,
    });
    mockRegistry.getManager.mockReturnValue(null);

    const res = await request(app)
      .put('/src-1')
      .send({ config: { host: '1.2.3.4', port: 4403, autoConnect: true } });

    expect(res.status).toBe(200);
    expect(mockRegistry.addManager).toHaveBeenCalledTimes(1);
    expect(mockRegistry.removeManager).not.toHaveBeenCalled();
  });
});
