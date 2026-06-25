/**
 * Source Routes — aggregate dashboard endpoint tests (#3735)
 *
 * GET /api/sources/:id/dashboard bundles a source's nodes, traceroutes,
 * neighbor-info and channels into ONE response so the dashboard stops firing
 * four separate GETs per source on every poll. These tests assert the bundle
 * shape and that per-dataset permission gating matches the individual routes
 * (a dataset the caller can't read comes back as [] instead of 403-ing the
 * whole bundle).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { Express } from 'express';
import session from 'express-session';
import request from 'supertest';
import sourceRoutes from './sourceRoutes.js';
import databaseService from '../../services/database.js';

vi.mock('../../services/database.js', () => ({
  default: {
    sources: { getSource: vi.fn(), getAllSources: vi.fn() },
    nodes: { getAllNodes: vi.fn(), getNode: vi.fn(), getNodesByNums: vi.fn() },
    traceroutes: { getAllTraceroutes: vi.fn() },
    neighbors: { getAllNeighborInfo: vi.fn() },
    channels: { getAllChannels: vi.fn() },
    settings: { getSetting: vi.fn() },
    checkPermissionAsync: vi.fn(),
    findUserByIdAsync: vi.fn(),
    findUserByUsernameAsync: vi.fn(),
    getUserPermissionSetAsync: vi.fn(),
    getChannelDatabasePermissionsForUserAsSetAsync: vi.fn(),
  },
}));

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: { getManager: vi.fn().mockReturnValue(null), startManager: vi.fn(), stopManager: vi.fn() },
}));

vi.mock('../meshtasticManager.js', () => ({
  MeshtasticManager: vi.fn().mockImplementation(() => ({ start: vi.fn(), stop: vi.fn() })),
}));

const mockDb = databaseService as any;
const MOCK_SOURCE = { id: 'src-mqtt', name: 'Test MQTT', type: 'mqtt_broker', enabled: true };

const createApp = (user: any): Express => {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false, cookie: { secure: false } }));
  app.use((req: any, _res: any, next: any) => {
    if (user) {
      req.session.userId = user.id;
      mockDb.findUserByIdAsync.mockResolvedValue(user);
    }
    next();
  });
  app.use('/', sourceRoutes);
  return app;
};

const adminUser = { id: 1, username: 'admin', isActive: true, isAdmin: true };
const regularUser = { id: 7, username: 'viewer', isActive: true, isAdmin: false };

describe('GET /:id/dashboard — bundled source datasets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.findUserByIdAsync.mockResolvedValue(adminUser);
    mockDb.findUserByUsernameAsync.mockResolvedValue(null);
    mockDb.checkPermissionAsync.mockResolvedValue(true);
    mockDb.getUserPermissionSetAsync.mockResolvedValue({});
    mockDb.getChannelDatabasePermissionsForUserAsSetAsync.mockResolvedValue({});
    mockDb.sources.getSource.mockResolvedValue(MOCK_SOURCE);
    mockDb.nodes.getAllNodes.mockResolvedValue([{ nodeNum: 1, nodeId: '!00000001', channel: 0 }]);
    mockDb.nodes.getNodesByNums.mockResolvedValue(new Map());
    mockDb.traceroutes.getAllTraceroutes.mockResolvedValue([{ id: 1, fromNodeNum: 1, toNodeNum: 2, channel: 0 }]);
    mockDb.neighbors.getAllNeighborInfo.mockResolvedValue([]);
    mockDb.channels.getAllChannels.mockResolvedValue([{ id: 0, name: 'Primary', role: 1 }]);
    mockDb.settings.getSetting.mockResolvedValue(null);
  });

  it('404s for an unknown source', async () => {
    mockDb.sources.getSource.mockResolvedValue(null);
    const res = await request(createApp(adminUser)).get('/nope/dashboard');
    expect(res.status).toBe(404);
  });

  it('bundles all four datasets for an admin', async () => {
    const res = await request(createApp(adminUser)).get('/src-mqtt/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.sourceId).toBe('src-mqtt');
    expect(res.body.nodes).toHaveLength(1);
    expect(res.body.traceroutes).toHaveLength(1);
    expect(res.body.neighborInfo).toEqual([]);
    expect(res.body.channels).toHaveLength(1);
  });

  it('gates each dataset independently — a denied dataset comes back as [] without 403', async () => {
    // nodes:read granted, traceroute:read denied. The traceroute dataset should
    // be empty AND its query should be skipped entirely (no wasted DB read),
    // while the rest of the bundle still returns.
    mockDb.checkPermissionAsync.mockImplementation((_uid: number, resource: string) =>
      Promise.resolve(resource !== 'traceroute'),
    );

    const res = await request(createApp(regularUser)).get('/src-mqtt/dashboard');

    expect(res.status).toBe(200);
    expect(res.body.traceroutes).toEqual([]);
    expect(mockDb.traceroutes.getAllTraceroutes).not.toHaveBeenCalled();
    // Other datasets are still present (arrays), not 403.
    expect(Array.isArray(res.body.nodes)).toBe(true);
    expect(Array.isArray(res.body.channels)).toBe(true);
    expect(Array.isArray(res.body.neighborInfo)).toBe(true);
  });
});
