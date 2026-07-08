/**
 * sourceRoutes — mqtt_bridge `mode` field validation.
 *
 * Covers the validator gating accepted values to the
 * { bidirectional, publish_only, subscribe_only } enum and the absent /
 * null cases (which mean "use the manager default").
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
      deleteSource: vi.fn().mockResolvedValue(true),
    },
    nodes: { getAllNodes: vi.fn().mockResolvedValue([]) },
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
  },
}));

vi.mock('../mqttBrokerManager.js', () => {
  class MqttBrokerManager {
    sourceId: string;
    sourceType = 'mqtt_broker' as const;
    constructor(id: string) {
      this.sourceId = id;
    }
    async start() {}
    async stop() {}
    on() { return this; }
    off() { return this; }
    getStatus() {
      return { sourceId: this.sourceId, sourceName: '', sourceType: 'mqtt_broker' as const, connected: false };
    }
    getLocalNodeInfo() { return null; }
  }
  return { MqttBrokerManager };
});

vi.mock('../mqttBridgeManager.js', () => {
  class MqttBridgeManager {
    sourceId: string;
    sourceType = 'mqtt_bridge' as const;
    constructor(id: string) {
      this.sourceId = id;
    }
    async start() {}
    async stop() {}
    on() { return this; }
    off() { return this; }
    getStatus() {
      return { sourceId: this.sourceId, sourceName: '', sourceType: 'mqtt_bridge' as const, connected: false };
    }
    getLocalNodeInfo() { return null; }
  }
  return { MqttBridgeManager };
});

const mockDb = databaseService as any;
const mockRegistry = sourceManagerRegistry as any;

const adminUser = { id: 1, username: 'admin', isActive: true, isAdmin: true };

const createApp = (): Express => {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false, cookie: { secure: false } }));
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

describe('sourceRoutes — mqtt_bridge mode validation', () => {
  const baseConfig = (mode?: unknown) => ({
    upstream: { url: 'mqtt://mqtt.meshtastic.org:1883' },
    subscriptions: ['msh/#'],
    ...(mode !== undefined ? { mode } : {}),
  });

  it.each([['bidirectional'], ['publish_only'], ['subscribe_only']])(
    'POST accepts mode=%s',
    async (mode) => {
      const app = createApp();
      mockDb.sources.getAllSources.mockResolvedValue([]);
      mockDb.sources.createSource.mockImplementation(async (s: any) => ({
        ...s,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));

      const res = await request(app)
        .post('/')
        .send({ name: 'Test', type: 'mqtt_bridge', config: baseConfig(mode) });

      expect(res.status).toBe(201);
      const created = mockDb.sources.createSource.mock.calls[0][0];
      expect(created.config.mode).toBe(mode);
    },
  );

  it('POST accepts a missing mode (defaults applied at runtime)', async () => {
    const app = createApp();
    mockDb.sources.getAllSources.mockResolvedValue([]);
    mockDb.sources.createSource.mockImplementation(async (s: any) => ({
      ...s,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const res = await request(app)
      .post('/')
      .send({ name: 'Test', type: 'mqtt_bridge', config: baseConfig() });

    expect(res.status).toBe(201);
    expect(mockDb.sources.createSource.mock.calls[0][0].config.mode).toBeUndefined();
  });

  it('POST rejects an unknown mode', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/')
      .send({ name: 'Test', type: 'mqtt_bridge', config: baseConfig('write_only') });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/mode must be one of/);
  });

  it('PUT rejects an unknown mode on an existing bridge', async () => {
    const app = createApp();
    const existing = {
      id: 'bridge-1',
      type: 'mqtt_bridge' as const,
      name: 'Bridge',
      enabled: true,
      config: baseConfig('bidirectional'),
    };
    mockDb.sources.getSource.mockResolvedValue(existing);

    const res = await request(app)
      .put('/bridge-1')
      .send({ config: baseConfig('all_the_things') });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/mode must be one of/);
    expect(mockDb.sources.updateSource).not.toHaveBeenCalled();
  });
});
