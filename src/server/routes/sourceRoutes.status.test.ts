/**
 * Source Routes — GET /:id/status for meshcore sources.
 *
 * After #3962 Task 2.1, MeshCore managers live in the unified sourceManagerRegistry
 * alongside Meshtastic managers. The status endpoint queries sourceManagerRegistry
 * for all source types — there is no separate meshcoreManagerRegistry.
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
    },
    nodes: {
      getNodeCount: vi.fn().mockResolvedValue(0),
      getActiveNodeCount: vi.fn().mockResolvedValue(0),
      getNode: vi.fn().mockResolvedValue(null),
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

vi.mock('../meshcoreConfig.js', () => ({
  meshcoreConfigFromSource: vi.fn().mockReturnValue(null),
}));

vi.mock('../meshcoreManager.js', () => {
  class MeshCoreManager {
    sourceId: string;
    sourceType: string = 'meshcore';
    constructor(sourceId: string) { this.sourceId = sourceId; }
    configure = vi.fn();
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    isConnected = vi.fn().mockReturnValue(false);
    disconnect = vi.fn().mockResolvedValue(undefined);
    connect = vi.fn().mockResolvedValue(true);
    getStatus = vi.fn().mockReturnValue({ sourceId: '', sourceName: '', sourceType: 'meshcore', connected: false });
    getLocalNodeInfo = vi.fn().mockReturnValue(null);
  }
  return { MeshCoreManager };
});

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
  mockDb.nodes.getNode.mockResolvedValue(null);
  mockSourceRegistry.getManager.mockReturnValue(null);
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
    // MeshCore manager is now in the unified sourceManagerRegistry.
    mockSourceRegistry.getManager.mockReturnValue({
      sourceId: 'mc-1',
      sourceType: 'meshcore',
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
    // MeshCore manager is now in the unified sourceManagerRegistry.
    mockSourceRegistry.getManager.mockReturnValue({
      sourceId: 'mc-3',
      sourceType: 'meshcore',
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
    // sourceManagerRegistry is the single source of truth — there is no
    // separate MeshCore-only registry to consult.
  });
});

describe('GET /:id/status — injected local node count (issue #3354)', () => {
  // The /:id/nodes endpoint injects the manager's local node into the list
  // when it isn't persisted for the source (e.g. the MQTT broker's synthetic
  // gateway). The /status nodeCount must mirror that so the sidebar badge
  // matches the node list and doesn't flicker on selection state.
  it('counts the synthetic gateway node not present in the nodes table', async () => {
    const app = createApp();
    mockDb.sources.getSource.mockResolvedValue({
      id: 'broker-1',
      name: 'MQTT_BROKER',
      type: 'mqtt_broker',
      enabled: true,
      config: { gateway: { nodeNum: 0xdeadbeef } },
      createdAt: 0,
      updatedAt: 0,
      createdBy: 1,
    });
    mockDb.nodes.getNodeCount.mockResolvedValue(11);
    mockDb.nodes.getActiveNodeCount.mockResolvedValue(5);
    // The gateway nodeNum is not stored for this source.
    mockDb.nodes.getNode.mockResolvedValue(null);
    mockSourceRegistry.getManager.mockReturnValue({
      getStatus: () => ({
        sourceId: 'broker-1',
        sourceName: 'MQTT_BROKER',
        sourceType: 'mqtt_broker',
        connected: true,
      }),
      getLocalNodeInfo: () => ({
        nodeNum: 0xdeadbeef,
        nodeId: '!deadbeef',
        longName: 'Broker GW',
        shortName: 'BGW',
      }),
    });

    const res = await request(app).get('/broker-1/status');

    expect(res.status).toBe(200);
    // 11 stored + 1 injected gateway = 12, matching the /nodes list.
    expect(res.body.nodeCount).toBe(12);
    // Connected, so the injected node counts as active too: 5 + 1.
    expect(res.body.activeNodeCount).toBe(6);
    expect(mockDb.nodes.getNode).toHaveBeenCalledWith(0xdeadbeef, 'broker-1');
  });

  it('does not double-count when the local node is already in the table', async () => {
    const app = createApp();
    mockDb.sources.getSource.mockResolvedValue({
      id: 'mt-2',
      name: 'Meshtastic',
      type: 'meshtastic_tcp',
      enabled: true,
      config: { host: '1.2.3.4', port: 4403 },
      createdAt: 0,
      updatedAt: 0,
      createdBy: 1,
    });
    mockDb.nodes.getNodeCount.mockResolvedValue(893);
    mockDb.nodes.getActiveNodeCount.mockResolvedValue(40);
    // Local node IS persisted for this source — getNodeCount already includes it.
    mockDb.nodes.getNode.mockResolvedValue({ nodeNum: 123, sourceId: 'mt-2' });
    mockSourceRegistry.getManager.mockReturnValue({
      getStatus: () => ({
        sourceId: 'mt-2',
        sourceName: 'Meshtastic',
        sourceType: 'meshtastic_tcp',
        connected: true,
      }),
      getLocalNodeInfo: () => ({ nodeNum: 123, nodeId: '!7b', longName: 'Local', shortName: 'LCL' }),
    });

    const res = await request(app).get('/mt-2/status');

    expect(res.status).toBe(200);
    expect(res.body.nodeCount).toBe(893);
    expect(res.body.activeNodeCount).toBe(40);
  });

  it('does not count the injected node as active when the source is disconnected', async () => {
    const app = createApp();
    mockDb.sources.getSource.mockResolvedValue({
      id: 'broker-2',
      name: 'MQTT_BROKER',
      type: 'mqtt_broker',
      enabled: true,
      config: { gateway: { nodeNum: 0xfeed } },
      createdAt: 0,
      updatedAt: 0,
      createdBy: 1,
    });
    mockDb.nodes.getNodeCount.mockResolvedValue(11);
    mockDb.nodes.getActiveNodeCount.mockResolvedValue(0);
    mockDb.nodes.getNode.mockResolvedValue(null);
    mockSourceRegistry.getManager.mockReturnValue({
      getStatus: () => ({
        sourceId: 'broker-2',
        sourceName: 'MQTT_BROKER',
        sourceType: 'mqtt_broker',
        connected: false,
      }),
      getLocalNodeInfo: () => ({ nodeNum: 0xfeed, nodeId: '!feed', longName: 'GW', shortName: 'GW' }),
    });

    const res = await request(app).get('/broker-2/status');

    expect(res.status).toBe(200);
    expect(res.body.nodeCount).toBe(12);
    // Disconnected → injected node is not counted as active.
    expect(res.body.activeNodeCount).toBe(0);
  });
});
