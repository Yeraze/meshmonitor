/**
 * POST /api/sources/:id/prune-outside-roi route tests.
 *
 * Asserts the validation gate (mqtt_bridge + geo bbox required) and that
 * the handler delegates to databaseService.pruneNodesOutsideBboxAsync
 * with the correct bbox unpacked from the source config.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { Express } from 'express';
import session from 'express-session';
import request from 'supertest';
import sourceRoutes from './sourceRoutes.js';
import databaseService from '../../services/database.js';

vi.mock('../../services/database.js', () => ({
  default: {
    sources: {
      getSource: vi.fn(),
      getAllSources: vi.fn().mockResolvedValue([]),
    },
    nodes: {
      getAllNodes: vi.fn().mockResolvedValue([]),
    },
    pruneNodesOutsideBboxAsync: vi.fn(),
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
});

describe('POST /api/sources/:id/prune-outside-roi', () => {
  it('returns 404 when the source does not exist', async () => {
    mockDb.sources.getSource.mockResolvedValue(null);

    const res = await request(createApp()).post('/missing/prune-outside-roi');
    expect(res.status).toBe(404);
    expect(mockDb.pruneNodesOutsideBboxAsync).not.toHaveBeenCalled();
  });

  it('returns 400 when the source is not an mqtt_bridge', async () => {
    mockDb.sources.getSource.mockResolvedValue({
      id: 'src-tcp', name: 'Sandbox', type: 'meshtastic_tcp', enabled: true,
      config: { host: '127.0.0.1', port: 4403 },
      createdAt: 0, updatedAt: 0, createdBy: 1,
    });

    const res = await request(createApp()).post('/src-tcp/prune-outside-roi');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/mqtt_bridge/);
    expect(mockDb.pruneNodesOutsideBboxAsync).not.toHaveBeenCalled();
  });

  it('returns 400 when the bridge has no geo bbox configured', async () => {
    mockDb.sources.getSource.mockResolvedValue({
      id: 'bridge-1', name: 'Bridge', type: 'mqtt_bridge', enabled: true,
      config: {
        brokerSourceId: 'broker-1',
        upstream: { url: 'mqtt://x' },
        subscriptions: ['msh/#'],
        // no downlinkFilters
      },
      createdAt: 0, updatedAt: 0, createdBy: 1,
    });

    const res = await request(createApp()).post('/bridge-1/prune-outside-roi');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/bounding box/);
    expect(mockDb.pruneNodesOutsideBboxAsync).not.toHaveBeenCalled();
  });

  it('returns 400 when downlinkFilters.geo exists but has no defined bounds', async () => {
    mockDb.sources.getSource.mockResolvedValue({
      id: 'bridge-2', name: 'Bridge', type: 'mqtt_bridge', enabled: true,
      config: {
        brokerSourceId: 'broker-1',
        upstream: { url: 'mqtt://x' },
        subscriptions: ['msh/#'],
        downlinkFilters: { geo: { /* all undefined */ } },
      },
      createdAt: 0, updatedAt: 0, createdBy: 1,
    });

    const res = await request(createApp()).post('/bridge-2/prune-outside-roi');
    expect(res.status).toBe(400);
    expect(mockDb.pruneNodesOutsideBboxAsync).not.toHaveBeenCalled();
  });

  it('passes the bbox to the service and returns the deleted count on success', async () => {
    mockDb.sources.getSource.mockResolvedValue({
      id: 'bridge-3', name: 'Florida MQTT', type: 'mqtt_bridge', enabled: true,
      config: {
        brokerSourceId: 'broker-1',
        upstream: { url: 'mqtt://x' },
        subscriptions: ['msh/US/FL/#'],
        downlinkFilters: {
          geo: { minLat: 24.33, maxLat: 27.53, minLng: -81.30, maxLng: -77.67 },
        },
      },
      createdAt: 0, updatedAt: 0, createdBy: 1,
    });
    mockDb.pruneNodesOutsideBboxAsync.mockResolvedValue(113);

    const res = await request(createApp()).post('/bridge-3/prune-outside-roi');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, count: 113, sourceId: 'bridge-3' });
    expect(mockDb.pruneNodesOutsideBboxAsync).toHaveBeenCalledWith('bridge-3', {
      minLat: 24.33,
      maxLat: 27.53,
      minLng: -81.30,
      maxLng: -77.67,
    });
  });

  it('forwards only the defined axes to the service when some bounds are absent', async () => {
    mockDb.sources.getSource.mockResolvedValue({
      id: 'bridge-4', name: 'Lat-only', type: 'mqtt_bridge', enabled: true,
      config: {
        brokerSourceId: 'broker-1',
        upstream: { url: 'mqtt://x' },
        subscriptions: ['msh/#'],
        // Only latitude bounds configured.
        downlinkFilters: { geo: { minLat: 24.33, maxLat: 27.53 } },
      },
      createdAt: 0, updatedAt: 0, createdBy: 1,
    });
    mockDb.pruneNodesOutsideBboxAsync.mockResolvedValue(5);

    const res = await request(createApp()).post('/bridge-4/prune-outside-roi');
    expect(res.status).toBe(200);
    expect(mockDb.pruneNodesOutsideBboxAsync).toHaveBeenCalledWith('bridge-4', {
      minLat: 24.33,
      maxLat: 27.53,
      minLng: undefined,
      maxLng: undefined,
    });
  });

  it('returns 500 and does not leak internal state when the service throws', async () => {
    mockDb.sources.getSource.mockResolvedValue({
      id: 'bridge-5', name: 'Florida', type: 'mqtt_bridge', enabled: true,
      config: {
        brokerSourceId: 'broker-1',
        upstream: { url: 'mqtt://x' },
        subscriptions: ['msh/#'],
        downlinkFilters: { geo: { minLat: 24.33, maxLat: 27.53, minLng: -81, maxLng: -77 } },
      },
      createdAt: 0, updatedAt: 0, createdBy: 1,
    });
    mockDb.pruneNodesOutsideBboxAsync.mockRejectedValue(new Error('boom'));

    const res = await request(createApp()).post('/bridge-5/prune-outside-roi');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to prune nodes');
  });
});
