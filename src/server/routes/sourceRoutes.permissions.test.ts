/**
 * Source Routes — per-source permission isolation tests
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
      getNode: vi.fn(),
      getAllNodes: vi.fn().mockResolvedValue([]),
      getNodesByNums: vi.fn().mockResolvedValue(new Map()),
    },
    messages: {
      getMessages: vi.fn().mockResolvedValue([]),
    },
    traceroutes: {
      getAllTraceroutes: vi.fn().mockResolvedValue([]),
    },
    neighbors: {
      getAllNeighborInfo: vi.fn().mockResolvedValue([]),
    },
    channels: {
      getAllChannels: vi.fn().mockResolvedValue([]),
    },
    settings: {
      getSetting: vi.fn().mockResolvedValue(null),
    },
    checkPermissionAsync: vi.fn(),
    findUserByIdAsync: vi.fn(),
    findUserByUsernameAsync: vi.fn(),
    getUserPermissionSetAsync: vi.fn(),
    getChannelDatabasePermissionsForUserAsSetAsync: vi.fn().mockResolvedValue({}),
  }
}));

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn().mockReturnValue(null),
    startManager: vi.fn(),
    stopManager: vi.fn(),
  }
}));

vi.mock('../meshtasticManager.js', () => ({
  MeshtasticManager: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  }))
}));

const mockDb = databaseService as any;

const normalUser = { id: 7, username: 'scoped', isActive: true, isAdmin: false };

const createApp = (): Express => {
  const app = express();
  app.use(express.json());
  app.use(session({
    secret: 'test-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
  }));
  app.use((req: any, _res, next) => {
    req.session.userId = normalUser.id;
    next();
  });
  app.use('/', sourceRoutes);
  return app;
};

describe('sourceRoutes — per-source permission isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.findUserByIdAsync.mockResolvedValue(normalUser);
    mockDb.findUserByUsernameAsync.mockResolvedValue(null);
    mockDb.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: false });
    // User has access ONLY to sourceA — implements per-source grant simulation
    mockDb.checkPermissionAsync.mockImplementation(
      (_uid: number, _r: string, _a: string, sourceId?: string) => Promise.resolve(sourceId === 'sourceA')
    );
    mockDb.sources.getSource.mockImplementation((id: string) =>
      Promise.resolve({ id, name: id, type: 'meshtastic_tcp', enabled: true })
    );
  });

  // /channels deliberately excluded from this loop — see MM-SEC-7.
  // After MM-SEC-7 the route is `optionalAuth()` + per-row `channel_${id}:read`,
  // so the "other source denied" case returns 200 with `[]` rather than 403.
  // Dedicated coverage lives in `sourceRoutes.security.test.ts`.
  const endpoints = ['/messages', '/nodes', '/traceroutes', '/neighbor-info'];

  for (const ep of endpoints) {
    it(`GET /sourceA${ep} → 200 (allowed source)`, async () => {
      const res = await request(createApp()).get(`/sourceA${ep}`);
      expect(res.status).toBe(200);
    });

    it(`GET /sourceB${ep} → 403 (other source denied)`, async () => {
      const res = await request(createApp()).get(`/sourceB${ep}`);
      expect(res.status).toBe(403);
    });
  }

  it('GET /sourceB/channels → 200 with [] (MM-SEC-7: per-channel filter, not source-level 403)', async () => {
    const res = await request(createApp()).get('/sourceB/channels');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('sourceRoutes — cross-source channel filtering (regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.findUserByIdAsync.mockResolvedValue(normalUser);
    mockDb.findUserByUsernameAsync.mockResolvedValue(null);

    // User can access both sources at the source level
    mockDb.checkPermissionAsync.mockResolvedValue(true);

    // Channel permissions differ by source:
    // sourceA: channel_0 viewOnMap granted
    // sourceB: NO channel permissions
    // getUserPermissionSetAsync returns a flat PermissionSet (Record<ResourceType, {...}>)
    mockDb.getUserPermissionSetAsync.mockImplementation((_uid: number, sourceId?: string) => {
      if (sourceId === 'sourceA') {
        return Promise.resolve({
          channel_0: { read: true, write: false, viewOnMap: true },
          nodes: { read: true, write: false, viewOnMap: false },
        });
      }
      // sourceB or no sourceId: no channel_0 permission
      return Promise.resolve({
        nodes: { read: true, write: false, viewOnMap: false },
      });
    });

    mockDb.getChannelDatabasePermissionsForUserAsSetAsync.mockResolvedValue({});

    mockDb.sources.getSource.mockImplementation((id: string) =>
      Promise.resolve({ id, name: id, type: 'meshtastic_tcp', enabled: true })
    );

    // Return a node on channel 0 for both sources
    mockDb.nodes.getAllNodes.mockResolvedValue([
      { nodeId: '!aabbccdd', nodeNum: 2864434397, longName: 'TestNode', shortName: 'TN', channel: 0, lastHeard: Date.now() },
    ]);
  });

  it('nodes on channel_0 visible on sourceA (granted)', async () => {
    const res = await request(createApp()).get('/sourceA/nodes');
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
  });

  it('nodes on channel_0 filtered on sourceB (no grant — regression)', async () => {
    const res = await request(createApp()).get('/sourceB/nodes');
    expect(res.status).toBe(200);
    // Node should be filtered out because sourceB has no channel_0 permissions
    expect(res.body.length).toBe(0);
  });

  it('admin sees nodes on all sources regardless of grants', async () => {
    const adminUser = { id: 1, username: 'admin', isActive: true, isAdmin: true };
    mockDb.findUserByIdAsync.mockResolvedValue(adminUser);
    mockDb.getUserPermissionSetAsync.mockResolvedValue({});

    const app = createApp();

    const resA = await request(app).get('/sourceA/nodes');
    expect(resA.status).toBe(200);
    expect(resA.body.length).toBe(1);

    const resB = await request(app).get('/sourceB/nodes');
    expect(resB.status).toBe(200);
    expect(resB.body.length).toBe(1);
  });
});
