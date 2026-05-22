/**
 * sourceRoutes — standalone mqtt_bridge regressions (issue #3134).
 *
 * Covers:
 *   - POST creates an mqtt_bridge without `brokerSourceId` (standalone).
 *   - POST still rejects an mqtt_bridge whose `brokerSourceId` references
 *     a missing source or a non-broker source.
 *   - DELETE on an mqtt_broker with bridge dependents no longer returns
 *     409 — it detaches the dependents (clears their `brokerSourceId`)
 *     and proceeds with deletion.
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

// Stub MQTT manager constructors so create/delete don't try to bind sockets.
vi.mock('../mqttBrokerManager.js', () => {
  class MqttBrokerManager {
    sourceId: string;
    sourceType = 'mqtt_broker' as const;
    constructor(id: string) {
      this.sourceId = id;
    }
    async start() {}
    async stop() {}
    on() {
      return this;
    }
    off() {
      return this;
    }
    getStatus() {
      return { sourceId: this.sourceId, sourceName: '', sourceType: 'mqtt_broker' as const, connected: false };
    }
    getLocalNodeInfo() {
      return null;
    }
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
    on() {
      return this;
    }
    off() {
      return this;
    }
    getStatus() {
      return { sourceId: this.sourceId, sourceName: '', sourceType: 'mqtt_bridge' as const, connected: false };
    }
    getLocalNodeInfo() {
      return null;
    }
  }
  return { MqttBridgeManager };
});

vi.mock('../meshcoreRegistry.js', () => ({
  meshcoreManagerRegistry: {
    get: vi.fn().mockReturnValue(null),
    getOrCreate: vi.fn(),
    remove: vi.fn().mockResolvedValue(undefined),
  },
  meshcoreConfigFromSource: vi.fn().mockReturnValue(null),
}));

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
    }),
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

describe('sourceRoutes — POST creates standalone mqtt_bridge (#3134)', () => {
  it('accepts mqtt_bridge config with no brokerSourceId', async () => {
    const app = createApp();
    mockDb.sources.getAllSources.mockResolvedValue([]);
    mockDb.sources.createSource.mockImplementation(async (s: any) => ({
      ...s,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const res = await request(app)
      .post('/')
      .send({
        name: 'Standalone',
        type: 'mqtt_bridge',
        config: {
          // brokerSourceId intentionally omitted
          upstream: { url: 'mqtt://mqtt.meshtastic.org:1883' },
          subscriptions: ['msh/#'],
        },
      });

    expect(res.status).toBe(201);
    expect(mockDb.sources.createSource).toHaveBeenCalledTimes(1);
    const created = mockDb.sources.createSource.mock.calls[0][0];
    expect(created.type).toBe('mqtt_bridge');
    expect(created.config.brokerSourceId).toBeUndefined();
  });

  it('accepts mqtt_bridge config with brokerSourceId explicitly empty', async () => {
    const app = createApp();
    mockDb.sources.getAllSources.mockResolvedValue([]);
    mockDb.sources.createSource.mockImplementation(async (s: any) => ({
      ...s,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const res = await request(app)
      .post('/')
      .send({
        name: 'Standalone',
        type: 'mqtt_bridge',
        config: {
          brokerSourceId: '',
          upstream: { url: 'mqtt://mqtt.meshtastic.org:1883' },
          subscriptions: ['msh/#'],
        },
      });

    expect(res.status).toBe(201);
  });

  it('still rejects mqtt_bridge whose brokerSourceId points at a missing source', async () => {
    const app = createApp();
    mockDb.sources.getSource.mockResolvedValue(null);

    const res = await request(app)
      .post('/')
      .send({
        name: 'Broken',
        type: 'mqtt_bridge',
        config: {
          brokerSourceId: 'missing-broker',
          upstream: { url: 'mqtt://example.com' },
          subscriptions: ['msh/#'],
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not reference an mqtt_broker/);
  });

  it('still rejects mqtt_bridge whose brokerSourceId points at a non-broker', async () => {
    const app = createApp();
    mockDb.sources.getSource.mockResolvedValue({
      id: 'tcp-source',
      type: 'meshtastic_tcp',
      name: 'TCP',
      config: {},
      enabled: true,
    });

    const res = await request(app)
      .post('/')
      .send({
        name: 'Broken',
        type: 'mqtt_bridge',
        config: {
          brokerSourceId: 'tcp-source',
          upstream: { url: 'mqtt://example.com' },
          subscriptions: ['msh/#'],
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not reference an mqtt_broker/);
  });
});

describe('sourceRoutes — DELETE broker with bridge dependents (#3134)', () => {
  it('detaches dependent bridges instead of returning 409', async () => {
    const app = createApp();

    const broker = {
      id: 'broker-1',
      type: 'mqtt_broker',
      name: 'Embedded',
      enabled: true,
      config: { listener: { port: 1883 }, auth: { username: 'u', password: 'p' }, gateway: {} },
    };
    const bridgeA = {
      id: 'bridge-a',
      type: 'mqtt_bridge',
      name: 'Bridge A',
      enabled: true,
      config: {
        brokerSourceId: 'broker-1',
        upstream: { url: 'mqtt://example.com' },
        subscriptions: ['msh/#'],
      },
    };
    const bridgeB = {
      id: 'bridge-b',
      type: 'mqtt_bridge',
      name: 'Bridge B',
      enabled: false, // disabled — should not be restarted
      config: {
        brokerSourceId: 'broker-1',
        upstream: { url: 'mqtt://example.com' },
        subscriptions: ['msh/#'],
      },
    };

    mockDb.sources.getSource.mockResolvedValue(broker);
    mockDb.sources.getAllSources.mockResolvedValue([broker, bridgeA, bridgeB]);

    const updatedConfigs: Record<string, any> = {};
    mockDb.sources.updateSource.mockImplementation(async (id: string, updates: any) => {
      updatedConfigs[id] = updates.config;
      return { id, ...updates };
    });

    const res = await request(app).delete('/broker-1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });

    // Both dependent bridges had brokerSourceId removed from their config.
    expect(updatedConfigs['bridge-a']).toBeDefined();
    expect(updatedConfigs['bridge-a'].brokerSourceId).toBeUndefined();
    expect(updatedConfigs['bridge-a'].upstream).toEqual({ url: 'mqtt://example.com' });

    expect(updatedConfigs['bridge-b']).toBeDefined();
    expect(updatedConfigs['bridge-b'].brokerSourceId).toBeUndefined();

    // The enabled bridge was restarted; the disabled one was not.
    expect(mockRegistry.removeManager).toHaveBeenCalledWith('bridge-a');
    expect(mockRegistry.addManager).toHaveBeenCalledTimes(1);
    expect(mockRegistry.removeManager).not.toHaveBeenCalledWith('bridge-b');

    // And the broker itself got deleted.
    expect(mockDb.sources.deleteSource).toHaveBeenCalledWith('broker-1');
  });

  it('still deletes a broker with no dependents', async () => {
    const app = createApp();

    const broker = {
      id: 'broker-1',
      type: 'mqtt_broker',
      name: 'Embedded',
      enabled: true,
      config: { listener: { port: 1883 }, auth: { username: 'u', password: 'p' }, gateway: {} },
    };

    mockDb.sources.getSource.mockResolvedValue(broker);
    mockDb.sources.getAllSources.mockResolvedValue([broker]);

    const res = await request(app).delete('/broker-1');

    expect(res.status).toBe(200);
    expect(mockDb.sources.deleteSource).toHaveBeenCalledWith('broker-1');
    expect(mockDb.sources.updateSource).not.toHaveBeenCalled();
  });
});
