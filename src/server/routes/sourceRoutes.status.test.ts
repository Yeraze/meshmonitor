/**
 * Source Routes — GET /:id/status fallback for meshcore sources.
 *
 * Meshcore managers live in their own registry (meshcoreManagerRegistry), not
 * sourceManagerRegistry, so the status endpoint must consult both before
 * reporting `connected: false` for a meshcore source.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { Express } from 'express';
import session from 'express-session';
import request from 'supertest';
import sourceRoutes from './sourceRoutes.js';
import databaseService from '../../services/database.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { meshcoreManagerRegistry } from '../meshcoreRegistry.js';

vi.mock('../../services/database.js', () => ({
  default: {
    sources: {
      getSource: vi.fn(),
      getAllSources: vi.fn().mockResolvedValue([]),
    },
    nodes: {
      getNodeCount: vi.fn().mockResolvedValue(0),
      getActiveNodeCount: vi.fn().mockResolvedValue(0),
    },
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

vi.mock('../meshcoreRegistry.js', () => ({
  meshcoreManagerRegistry: {
    get: vi.fn().mockReturnValue(undefined),
    getOrCreate: vi.fn(),
    remove: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockReturnValue([]),
  },
  meshcoreConfigFromSource: vi.fn().mockReturnValue(null),
}));

vi.mock('../meshtasticManager.js', () => {
  class MeshtasticManager {
    sourceId: string;
    constructor(sourceId: string) { this.sourceId = sourceId; }
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
const mockSourceRegistry = sourceManagerRegistry as any;
const mockMeshcoreRegistry = meshcoreManagerRegistry as any;

const adminUser = { id: 1, username: 'admin', isActive: true, isAdmin: true };

function createApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
  app.use((req: any, _res, next) => {
    req.session.userId = adminUser.id;
    next();
  });
  app.use('/', sourceRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.findUserByIdAsync.mockResolvedValue(adminUser);
  mockDb.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: true });
  mockDb.checkPermissionAsync.mockResolvedValue(true);
  mockSourceRegistry.getManager.mockReturnValue(null);
  mockMeshcoreRegistry.get.mockReturnValue(undefined);
});

describe('GET /:id/status — meshcore registry fallback', () => {
  it('reports connected: true for a meshcore source whose manager is connected', async () => {
    const app = createApp();
    mockDb.sources.getSource.mockResolvedValue({
      id: 'mc-1',
      name: 'My MeshCore',
      type: 'meshcore',
      enabled: true,
      config: {},
      createdAt: 0,
      updatedAt: 0,
      createdBy: 1,
    });
    // sourceManagerRegistry has nothing for meshcore — meshcoreManagerRegistry does
    mockMeshcoreRegistry.get.mockReturnValue({
      sourceId: 'mc-1',
      getStatus: (name: string) => ({
        sourceId: 'mc-1',
        sourceName: name,
        sourceType: 'meshcore',
        connected: true,
      }),
      getLocalNode: () => null,
      getAllNodes: () => [],
    });

    const res = await request(app).get('/mc-1/status');

    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    expect(res.body.sourceType).toBe('meshcore');
    expect(res.body.sourceName).toBe('My MeshCore');
  });

  it('reports connected: false for a meshcore source with no manager in either registry', async () => {
    const app = createApp();
    mockDb.sources.getSource.mockResolvedValue({
      id: 'mc-2',
      name: 'Idle MeshCore',
      type: 'meshcore',
      enabled: true,
      config: {},
      createdAt: 0,
      updatedAt: 0,
      createdBy: 1,
    });

    const res = await request(app).get('/mc-2/status');

    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(false);
    expect(res.body.sourceType).toBe('meshcore');
  });

  it('returns nodeCount/activeNodeCount from the meshcore manager (not the empty nodes table)', async () => {
    const app = createApp();
    mockDb.sources.getSource.mockResolvedValue({
      id: 'mc-3',
      name: 'Counting MeshCore',
      type: 'meshcore',
      enabled: true,
      config: {},
      createdAt: 0,
      updatedAt: 0,
      createdBy: 1,
    });
    const now = Date.now();
    mockMeshcoreRegistry.get.mockReturnValue({
      sourceId: 'mc-3',
      getStatus: (name: string) => ({
        sourceId: 'mc-3',
        sourceName: name,
        sourceType: 'meshcore',
        connected: true,
      }),
      getLocalNode: () => ({ publicKey: 'self', name: 'Self', advType: 1 }),
      // localNode (no lastHeard) + 2 fresh contacts + 1 stale contact
      getAllNodes: () => [
        { publicKey: 'self', name: 'Self', advType: 1 },
        { publicKey: 'a', name: 'Fresh A', advType: 1, lastHeard: now - 60_000 },
        { publicKey: 'b', name: 'Fresh B', advType: 1, lastHeard: now - 3_600_000 },
        { publicKey: 'c', name: 'Stale', advType: 1, lastHeard: now - 10_800_000 },
      ],
    });

    const res = await request(app).get('/mc-3/status');

    expect(res.status).toBe(200);
    expect(res.body.nodeCount).toBe(4);
    expect(res.body.activeNodeCount).toBe(3);
    // database fallbacks should NOT have been consulted for a meshcore source
    expect(mockDb.nodes.getNodeCount).not.toHaveBeenCalled();
    expect(mockDb.nodes.getActiveNodeCount).not.toHaveBeenCalled();
  });

  it('still uses sourceManagerRegistry for non-meshcore sources', async () => {
    const app = createApp();
    mockDb.sources.getSource.mockResolvedValue({
      id: 'mt-1',
      name: 'Meshtastic',
      type: 'meshtastic_tcp',
      enabled: true,
      config: { host: '1.2.3.4', port: 4403 },
      createdAt: 0,
      updatedAt: 0,
      createdBy: 1,
    });
    mockSourceRegistry.getManager.mockReturnValue({
      getStatus: () => ({
        sourceId: 'mt-1',
        sourceName: 'Meshtastic',
        sourceType: 'meshtastic_tcp',
        connected: true,
      }),
    });

    const res = await request(app).get('/mt-1/status');

    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    expect(mockMeshcoreRegistry.get).not.toHaveBeenCalled();
  });
});
