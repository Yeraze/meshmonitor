/**
 * Source Routes — nodes endpoint position-override tests
 *
 * Regression for #3551: GET /api/sources/:id/nodes returns raw DB rows that
 * (unlike /api/poll) never pass through enhanceNodeForClient. The per-node
 * position override therefore wasn't being applied to the flat lat/lng the
 * dashboard map reads, so overridden nodes kept rendering at their raw GPS
 * position. The endpoint must surface the override coordinates as the
 * effective latitude/longitude, while honoring the private-override flag.
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
      getAllSources: vi.fn(),
    },
    nodes: {
      getAllNodes: vi.fn(),
      getNode: vi.fn(),
    },
    settings: {
      getSetting: vi.fn(),
    },
    checkPermissionAsync: vi.fn(),
    findUserByIdAsync: vi.fn(),
    findUserByUsernameAsync: vi.fn(),
    getUserPermissionSetAsync: vi.fn(),
    getChannelDatabasePermissionsForUserAsSetAsync: vi.fn(),
  },
}));

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn().mockReturnValue(null),
    startManager: vi.fn(),
    stopManager: vi.fn(),
  },
}));

vi.mock('../meshtasticManager.js', () => ({
  MeshtasticManager: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

const mockDb = databaseService as any;

const MOCK_SOURCE = { id: 'src-tcp', name: 'Test TCP', type: 'meshtastic_tcp', enabled: true };

const createApp = (user: any): Express => {
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

// A node with both raw GPS and an enabled position override.
const overriddenNode = () => ({
  nodeNum: 100,
  nodeId: '!00000064',
  longName: 'Spoofed Node',
  shortName: 'SPF',
  channel: 0,
  // Raw GPS (off in Europe/Africa per the bug report)
  latitude: 9.123456,
  longitude: 38.987654,
  altitude: 100,
  // User-set override (the correct location)
  positionOverrideEnabled: true,
  latitudeOverride: 40.7128,
  longitudeOverride: -74.006,
  altitudeOverride: 10,
  positionOverrideIsPrivate: false,
});

describe('GET /:id/nodes — position override application (#3551)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.findUserByIdAsync.mockResolvedValue(adminUser);
    mockDb.findUserByUsernameAsync.mockResolvedValue(null);
    mockDb.checkPermissionAsync.mockResolvedValue(true);
    mockDb.getUserPermissionSetAsync.mockResolvedValue({});
    mockDb.getChannelDatabasePermissionsForUserAsSetAsync.mockResolvedValue({});
    mockDb.sources.getSource.mockResolvedValue(MOCK_SOURCE);
  });

  it('replaces flat latitude/longitude with the override coordinates', async () => {
    mockDb.nodes.getAllNodes.mockResolvedValue([overriddenNode()]);

    const res = await request(createApp(adminUser)).get('/src-tcp/nodes');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const node = res.body[0];
    expect(node.latitude).toBe(40.7128);
    expect(node.longitude).toBe(-74.006);
    expect(node.altitude).toBe(10);
    expect(node.positionIsOverride).toBe(true);
  });

  it('leaves raw GPS untouched when no override is enabled', async () => {
    const node = overriddenNode();
    node.positionOverrideEnabled = false;
    mockDb.nodes.getAllNodes.mockResolvedValue([node]);

    const res = await request(createApp(adminUser)).get('/src-tcp/nodes');

    expect(res.status).toBe(200);
    expect(res.body[0].latitude).toBe(9.123456);
    expect(res.body[0].longitude).toBe(38.987654);
    expect(res.body[0].positionIsOverride).toBeUndefined();
  });

  it('does not apply an override missing its coordinates', async () => {
    const node = overriddenNode();
    node.latitudeOverride = null as any;
    node.longitudeOverride = null as any;
    mockDb.nodes.getAllNodes.mockResolvedValue([node]);

    const res = await request(createApp(adminUser)).get('/src-tcp/nodes');

    expect(res.status).toBe(200);
    expect(res.body[0].latitude).toBe(9.123456);
    expect(res.body[0].longitude).toBe(38.987654);
  });

  it('applies a private override for an admin (can view private)', async () => {
    const node = overriddenNode();
    node.positionOverrideIsPrivate = true;
    mockDb.nodes.getAllNodes.mockResolvedValue([node]);

    const res = await request(createApp(adminUser)).get('/src-tcp/nodes');

    expect(res.status).toBe(200);
    expect(res.body[0].latitude).toBe(40.7128);
    expect(res.body[0].longitude).toBe(-74.006);
    expect(res.body[0].positionIsOverride).toBe(true);
  });

  it('hides a private override from a user without nodes_private read', async () => {
    const node = overriddenNode();
    node.positionOverrideIsPrivate = true;
    mockDb.nodes.getAllNodes.mockResolvedValue([node]);
    mockDb.findUserByIdAsync.mockResolvedValue(regularUser);
    // Grant nodes:read + channel_0 viewOnMap, but deny nodes_private:read.
    mockDb.checkPermissionAsync.mockImplementation(
      (_userId: number, resource: string) => Promise.resolve(resource !== 'nodes_private'),
    );
    mockDb.getUserPermissionSetAsync.mockResolvedValue({
      channel_0: { read: true, write: false, viewOnMap: true },
    });

    const res = await request(createApp(regularUser)).get('/src-tcp/nodes');

    expect(res.status).toBe(200);
    const result = res.body[0];
    // Override not applied — raw GPS preserved.
    expect(result.latitude).toBe(9.123456);
    expect(result.longitude).toBe(38.987654);
    expect(result.positionIsOverride).toBeUndefined();
    // Private override coordinates stripped from the response.
    expect(result.latitudeOverride).toBeUndefined();
    expect(result.longitudeOverride).toBeUndefined();
    expect(result.altitudeOverride).toBeUndefined();
  });
});
