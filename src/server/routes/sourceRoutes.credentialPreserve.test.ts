/**
 * Source Routes — credential preservation on PUT (regression test).
 *
 * The source-edit UI intentionally clears the password input on load and
 * omits the field from the save payload when the user does not type a new
 * one. The PUT handler must re-merge the stored password so unrelated
 * edits (e.g. toggling the geofence bounding box on an mqtt_bridge) do
 * not wipe the credential.
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

vi.mock('../mqttBridgeManager.js', () => {
  class MqttBridgeManager {
    constructor(public id: string, public name: string, public config: any) {}
    async start() {}
    async stop() {}
    getStatus() { return { sourceId: this.id, sourceName: this.name, sourceType: 'mqtt_bridge' as const, connected: false }; }
  }
  return { MqttBridgeManager };
});

vi.mock('../mqttBrokerManager.js', () => {
  class MqttBrokerManager {
    constructor(public id: string, public name: string, public config: any) {}
    async start() {}
    async stop() {}
    getStatus() { return { sourceId: this.id, sourceName: this.name, sourceType: 'mqtt_broker' as const, connected: false }; }
  }
  return { MqttBrokerManager };
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
  mockRegistry.getManager.mockReturnValue({ sourceId: 'src-1' });
  mockDb.sources.updateSource.mockImplementation((_id: string, updates: any) =>
    Promise.resolve({
      id: 'src-1',
      name: 'bridge',
      type: 'mqtt_bridge',
      enabled: true,
      config: updates.config,
      createdAt: 0,
      updatedAt: 0,
      createdBy: 1,
    })
  );
});

describe('sourceRoutes PUT — mqtt_bridge credential preservation', () => {
  it('restores the stored upstream password when the save payload omits it (geofence-only edit)', async () => {
    mockDb.sources.getSource.mockResolvedValue({
      id: 'src-1',
      name: 'bridge',
      type: 'mqtt_bridge',
      enabled: true,
      config: {
        brokerSourceId: 'broker-1',
        upstream: { url: 'mqtt://upstream.example.com', username: 'bridgeuser', password: 'stored-bridge-secret' },
        subscriptions: ['msh/#'],
      },
      createdAt: 0,
      updatedAt: 0,
      createdBy: 1,
    });

    const res = await request(createApp())
      .put('/src-1')
      .send({
        config: {
          brokerSourceId: 'broker-1',
          upstream: { url: 'mqtt://upstream.example.com', username: 'bridgeuser' },
          subscriptions: ['msh/#'],
          downlinkFilters: { geo: { minLat: 30, maxLat: 31, minLng: -90, maxLng: -89 } },
        },
      });

    expect(res.status).toBe(200);
    const savedConfig = mockDb.sources.updateSource.mock.calls[0][1].config;
    expect(savedConfig.upstream.password).toBe('stored-bridge-secret');
    expect(savedConfig.upstream.username).toBe('bridgeuser');
    expect(savedConfig.downlinkFilters.geo.minLat).toBe(30);
  });

  it('restores the stored password when upstream.password is explicitly undefined', async () => {
    mockDb.sources.getSource.mockResolvedValue({
      id: 'src-1',
      name: 'bridge',
      type: 'mqtt_bridge',
      enabled: true,
      config: {
        brokerSourceId: 'broker-1',
        upstream: { url: 'mqtt://u.example.com', username: 'u', password: 'kept-secret' },
        subscriptions: ['msh/#'],
      },
      createdAt: 0, updatedAt: 0, createdBy: 1,
    });

    const res = await request(createApp())
      .put('/src-1')
      .send({
        config: {
          brokerSourceId: 'broker-1',
          upstream: { url: 'mqtt://u.example.com', username: 'u', password: undefined },
          subscriptions: ['msh/#'],
        },
      });

    expect(res.status).toBe(200);
    const savedConfig = mockDb.sources.updateSource.mock.calls[0][1].config;
    expect(savedConfig.upstream.password).toBe('kept-secret');
  });

  it('allows admins to actually change the upstream password when they supply a new one', async () => {
    mockDb.sources.getSource.mockResolvedValue({
      id: 'src-1',
      name: 'bridge',
      type: 'mqtt_bridge',
      enabled: true,
      config: {
        brokerSourceId: 'broker-1',
        upstream: { url: 'mqtt://u.example.com', username: 'u', password: 'old-secret' },
        subscriptions: ['msh/#'],
      },
      createdAt: 0, updatedAt: 0, createdBy: 1,
    });

    const res = await request(createApp())
      .put('/src-1')
      .send({
        config: {
          brokerSourceId: 'broker-1',
          upstream: { url: 'mqtt://u.example.com', username: 'u', password: 'new-rotated-secret' },
          subscriptions: ['msh/#'],
        },
      });

    expect(res.status).toBe(200);
    const savedConfig = mockDb.sources.updateSource.mock.calls[0][1].config;
    expect(savedConfig.upstream.password).toBe('new-rotated-secret');
  });
});

describe('sourceRoutes PUT — mqtt_broker credential preservation', () => {
  beforeEach(() => {
    mockDb.sources.updateSource.mockImplementation((_id: string, updates: any) =>
      Promise.resolve({
        id: 'src-1',
        name: 'broker',
        type: 'mqtt_broker',
        enabled: true,
        config: updates.config,
        createdAt: 0,
        updatedAt: 0,
        createdBy: 1,
      })
    );
  });

  it('restores the stored auth.password when the save payload omits it', async () => {
    mockDb.sources.getSource.mockResolvedValue({
      id: 'src-1',
      name: 'broker',
      type: 'mqtt_broker',
      enabled: true,
      config: {
        listener: { port: 1883, host: '0.0.0.0' },
        auth: { username: 'mqttuser', password: 'stored-broker-secret' },
        gateway: { nodeNum: 0x80000001, nodeId: '!80000001', longName: 'broker', shortName: 'br' },
        rootTopic: 'msh',
      },
      createdAt: 0, updatedAt: 0, createdBy: 1,
    });

    const res = await request(createApp())
      .put('/src-1')
      .send({
        config: {
          listener: { port: 1884, host: '0.0.0.0' },
          auth: { username: 'mqttuser' },
          gateway: { nodeNum: 0x80000001, nodeId: '!80000001', longName: 'broker', shortName: 'br' },
          rootTopic: 'msh',
        },
      });

    expect(res.status).toBe(200);
    const savedConfig = mockDb.sources.updateSource.mock.calls[0][1].config;
    expect(savedConfig.auth.password).toBe('stored-broker-secret');
    expect(savedConfig.listener.port).toBe(1884);
  });

  it('writes a new password through when the admin supplies one', async () => {
    mockDb.sources.getSource.mockResolvedValue({
      id: 'src-1',
      name: 'broker',
      type: 'mqtt_broker',
      enabled: true,
      config: {
        listener: { port: 1883, host: '0.0.0.0' },
        auth: { username: 'mqttuser', password: 'old-broker-secret' },
        gateway: { nodeNum: 0x80000001, nodeId: '!80000001', longName: 'broker', shortName: 'br' },
        rootTopic: 'msh',
      },
      createdAt: 0, updatedAt: 0, createdBy: 1,
    });

    const res = await request(createApp())
      .put('/src-1')
      .send({
        config: {
          listener: { port: 1883, host: '0.0.0.0' },
          auth: { username: 'mqttuser', password: 'new-broker-secret' },
          gateway: { nodeNum: 0x80000001, nodeId: '!80000001', longName: 'broker', shortName: 'br' },
          rootTopic: 'msh',
        },
      });

    expect(res.status).toBe(200);
    const savedConfig = mockDb.sources.updateSource.mock.calls[0][1].config;
    expect(savedConfig.auth.password).toBe('new-broker-secret');
  });
});
