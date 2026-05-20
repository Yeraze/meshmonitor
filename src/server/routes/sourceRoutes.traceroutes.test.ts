/**
 * Source Routes — traceroutes endpoint tests
 *
 * Regression for #3092 follow-up: GET /api/sources/:id/traceroutes must
 * apply the same per-channel viewOnMap gate the nodes endpoint uses, so
 * the rows' embedded `routePositions` JSON can't leak hop coordinates
 * that the frontend would draw as "floating lines" once the matching
 * nodes have been filtered out of the nodes endpoint.
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
    traceroutes: {
      getAllTraceroutes: vi.fn(),
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

const MOCK_SOURCE = { id: 'src-mqtt', name: 'Test MQTT', type: 'mqtt_broker', enabled: true };
const CHANNEL_DB_OFFSET = 100; // mirrored from constants/meshtastic.ts

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

describe('GET /:id/traceroutes — channel masking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.findUserByIdAsync.mockResolvedValue(adminUser);
    mockDb.findUserByUsernameAsync.mockResolvedValue(null);
    mockDb.checkPermissionAsync.mockResolvedValue(true);
    mockDb.sources.getSource.mockResolvedValue(MOCK_SOURCE);
  });

  it('returns all traceroutes for admins (no channel gating)', async () => {
    const traceroutes = [
      { id: 1, fromNodeNum: 100, toNodeNum: 200, channel: CHANNEL_DB_OFFSET + 5 },
      { id: 2, fromNodeNum: 300, toNodeNum: 400, channel: 0 },
    ];
    mockDb.traceroutes.getAllTraceroutes.mockResolvedValue(traceroutes);
    mockDb.getUserPermissionSetAsync.mockResolvedValue({});
    mockDb.getChannelDatabasePermissionsForUserAsSetAsync.mockResolvedValue({});

    const res = await request(createApp(adminUser)).get('/src-mqtt/traceroutes');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it('drops traceroutes whose channel the non-admin user has no viewOnMap permission for', async () => {
    const traceroutes = [
      // MQTT-routed traceroute on virtual channel 5; user has no VC grants.
      { id: 1, fromNodeNum: 100, toNodeNum: 200, channel: CHANNEL_DB_OFFSET + 5 },
      // Slot-0 traceroute; user has no per-source channel_0 grant either.
      { id: 2, fromNodeNum: 300, toNodeNum: 400, channel: 0 },
    ];
    mockDb.traceroutes.getAllTraceroutes.mockResolvedValue(traceroutes);
    mockDb.findUserByIdAsync.mockResolvedValue(regularUser);
    mockDb.getUserPermissionSetAsync.mockResolvedValue({}); // no channel_0 grant
    mockDb.getChannelDatabasePermissionsForUserAsSetAsync.mockResolvedValue({}); // no VC grant

    const res = await request(createApp(regularUser)).get('/src-mqtt/traceroutes');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('keeps traceroutes on virtual channels the non-admin user has been granted viewOnMap on', async () => {
    const traceroutes = [
      { id: 1, fromNodeNum: 100, toNodeNum: 200, channel: CHANNEL_DB_OFFSET + 5 },
      { id: 2, fromNodeNum: 300, toNodeNum: 400, channel: CHANNEL_DB_OFFSET + 6 },
    ];
    mockDb.traceroutes.getAllTraceroutes.mockResolvedValue(traceroutes);
    mockDb.findUserByIdAsync.mockResolvedValue(regularUser);
    mockDb.getUserPermissionSetAsync.mockResolvedValue({});
    // User has viewOnMap on VC id=5 but not 6.
    mockDb.getChannelDatabasePermissionsForUserAsSetAsync.mockResolvedValue({
      5: { canViewOnMap: true, viewOnMap: true, canRead: true },
    });

    const res = await request(createApp(regularUser)).get('/src-mqtt/traceroutes');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(1);
  });
});
