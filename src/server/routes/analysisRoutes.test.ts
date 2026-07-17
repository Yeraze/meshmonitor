/**
 * Analysis Routes Tests
 *
 * Tests for GET /api/analysis/positions — permission-filtered, paginated
 * cross-source position query for the /analysis workspace.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { Express } from 'express';
import session from 'express-session';
import request from 'supertest';

vi.mock('../../services/database.js', () => ({
  default: {
    sources: { getAllSources: vi.fn() },
    analysis: { getPositions: vi.fn(), getCoverageGrid: vi.fn() },
    nodes: { getAllNodes: vi.fn() },
    checkPermissionAsync: vi.fn(),
    findUserByIdAsync: vi.fn(),
    findUserByUsernameAsync: vi.fn(),
    getUserPermissionSetAsync: vi.fn(),
    getChannelDatabasePermissionsForUserAsSetAsync: vi.fn(),
  },
}));

import analysisRoutes from './analysisRoutes.js';
import databaseService from '../../services/database.js';

const mockDb = databaseService as any;

const adminUser = { id: 1, username: 'admin', isActive: true, isAdmin: true };
const regularUser = { id: 2, username: 'user', isActive: true, isAdmin: false };

const SOURCE_A = { id: 'src-a', name: 'Source A', enabled: true };
const SOURCE_B = { id: 'src-b', name: 'Source B', enabled: true };

function createApp(user: any = null): Express {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test', resave: false, saveUninitialized: false, cookie: { secure: false } }));
  app.use((req: any, _res, next) => {
    if (user) {
      req.session.userId = user.id;
      mockDb.findUserByIdAsync.mockResolvedValue(user);
    }
    next();
  });
  app.use('/', analysisRoutes);
  return app;
}

describe('GET /positions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A, SOURCE_B]);
    mockDb.analysis.getPositions.mockResolvedValue({
      items: [], pageSize: 500, hasMore: false, nextCursor: null,
    });
    mockDb.nodes.getAllNodes.mockResolvedValue([]);
    mockDb.getUserPermissionSetAsync.mockResolvedValue({ channel_0: { viewOnMap: true, read: true, write: false } });
    mockDb.getChannelDatabasePermissionsForUserAsSetAsync.mockResolvedValue({});
    mockDb.checkPermissionAsync.mockResolvedValue(true);
  });

  it('admin: queries all enabled sources', async () => {
    const app = createApp(adminUser);
    const res = await request(app).get('/positions?since=0');
    expect(res.status).toBe(200);
    expect(mockDb.analysis.getPositions).toHaveBeenCalledWith(
      expect.objectContaining({ sourceIds: ['src-a', 'src-b'] }),
    );
  });

  it('regular user: queries only sources they have nodes:read on', async () => {
    mockDb.checkPermissionAsync.mockImplementation((_uid: number, _r: string, _a: string, sid: string) =>
      Promise.resolve(sid === 'src-a'),
    );
    const app = createApp(regularUser);
    const res = await request(app).get('/positions?since=0');
    expect(res.status).toBe(200);
    expect(mockDb.analysis.getPositions).toHaveBeenCalledWith(
      expect.objectContaining({ sourceIds: ['src-a'] }),
    );
  });

  it('intersects requested sources with permitted sources', async () => {
    mockDb.checkPermissionAsync.mockResolvedValue(true);
    const app = createApp(regularUser);
    await request(app).get('/positions?sources=src-b&since=0');
    expect(mockDb.analysis.getPositions).toHaveBeenCalledWith(
      expect.objectContaining({ sourceIds: ['src-b'] }),
    );
  });

  it('anonymous: returns empty when no sources are publicly readable', async () => {
    mockDb.checkPermissionAsync.mockResolvedValue(false);
    const app = createApp(null);
    const res = await request(app).get('/positions?since=0');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it('clamps pageSize at 2000', async () => {
    const app = createApp(adminUser);
    await request(app).get('/positions?since=0&pageSize=999999');
    expect(mockDb.analysis.getPositions).toHaveBeenCalledWith(
      expect.objectContaining({ pageSize: 2000 }),
    );
  });

  it('passes through cursor', async () => {
    const app = createApp(adminUser);
    await request(app).get('/positions?since=0&cursor=abc');
    expect(mockDb.analysis.getPositions).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: 'abc' }),
    );
  });

  it('filters out positions on channels the user lacks viewOnMap on', async () => {
    const posOnCh0 = { nodeNum: 1, sourceId: 'src-a', latitude: 1, longitude: 1, altitude: null, timestamp: 1000 };
    const posOnCh1 = { nodeNum: 2, sourceId: 'src-a', latitude: 2, longitude: 2, altitude: null, timestamp: 1000 };
    mockDb.analysis.getPositions.mockResolvedValue({
      items: [posOnCh0, posOnCh1], pageSize: 500, hasMore: false, nextCursor: null,
    });
    // node 1 is on channel 0 (viewOnMap granted), node 2 is on channel 1 (not granted)
    mockDb.nodes.getAllNodes.mockResolvedValue([
      { nodeNum: 1, channel: 0 },
      { nodeNum: 2, channel: 1 },
    ]);
    mockDb.getUserPermissionSetAsync.mockResolvedValue({
      channel_0: { viewOnMap: true, read: true, write: false },
      // channel_1 not granted
    });
    // nodes:read = true (allows source access), nodes_private:read = false (irrelevant here)
    mockDb.checkPermissionAsync.mockImplementation((_uid: number, resource: string) =>
      Promise.resolve(resource !== 'nodes_private'),
    );

    const app = createApp(regularUser);
    const res = await request(app).get('/positions?since=0');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].nodeNum).toBe(1);
  });

  it('filters out positions for nodes with private position override when user lacks nodes_private:read', async () => {
    const privatePos = { nodeNum: 99, sourceId: 'src-a', latitude: 5, longitude: 5, altitude: null, timestamp: 2000 };
    mockDb.analysis.getPositions.mockResolvedValue({
      items: [privatePos], pageSize: 500, hasMore: false, nextCursor: null,
    });
    mockDb.nodes.getAllNodes.mockResolvedValue([
      { nodeNum: 99, channel: 0, positionOverrideIsPrivate: true },
    ]);
    mockDb.getUserPermissionSetAsync.mockResolvedValue({
      channel_0: { viewOnMap: true, read: true, write: false },
    });
    // nodes_private:read denied
    mockDb.checkPermissionAsync.mockImplementation((_uid: number, resource: string) =>
      Promise.resolve(resource !== 'nodes_private'),
    );

    const app = createApp(regularUser);
    const res = await request(app).get('/positions?since=0');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
  });

  it('admin sees all positions regardless of channel or private override', async () => {
    const pos = { nodeNum: 99, sourceId: 'src-a', latitude: 5, longitude: 5, altitude: null, timestamp: 2000 };
    mockDb.analysis.getPositions.mockResolvedValue({
      items: [pos], pageSize: 500, hasMore: false, nextCursor: null,
    });
    mockDb.nodes.getAllNodes.mockResolvedValue([
      { nodeNum: 99, channel: 1, positionOverrideIsPrivate: true },
    ]);
    // Admin bypasses the permission gates; these mocks should not affect the result
    mockDb.getUserPermissionSetAsync.mockResolvedValue({});
    mockDb.checkPermissionAsync.mockResolvedValue(false);

    const app = createApp(adminUser);
    const res = await request(app).get('/positions?since=0');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
  });

  // #4162/#4163 — "Hide from Map" is a display gate that applies to every user,
  // admins included, so hidden nodes contribute no heatmap/coverage density.
  it('admin: hides positions for nodes with hideFromMap set', async () => {
    const visible = { nodeNum: 1, sourceId: 'src-a', latitude: 1, longitude: 1, altitude: null, timestamp: 1000 };
    const hidden = { nodeNum: 2, sourceId: 'src-a', latitude: 2, longitude: 2, altitude: null, timestamp: 1000 };
    mockDb.analysis.getPositions.mockResolvedValue({
      items: [visible, hidden], pageSize: 500, hasMore: false, nextCursor: null,
    });
    mockDb.nodes.getAllNodes.mockResolvedValue([
      { nodeNum: 1, channel: 0, hideFromMap: false },
      { nodeNum: 2, channel: 0, hideFromMap: true },
    ]);

    const app = createApp(adminUser);
    const res = await request(app).get('/positions?since=0');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].nodeNum).toBe(1);
  });

  it('regular user: hides positions for nodes with hideFromMap set', async () => {
    const visible = { nodeNum: 1, sourceId: 'src-a', latitude: 1, longitude: 1, altitude: null, timestamp: 1000 };
    const hidden = { nodeNum: 2, sourceId: 'src-a', latitude: 2, longitude: 2, altitude: null, timestamp: 1000 };
    mockDb.analysis.getPositions.mockResolvedValue({
      items: [visible, hidden], pageSize: 500, hasMore: false, nextCursor: null,
    });
    // Both nodes are on channel 0 with viewOnMap granted; only hideFromMap differs.
    mockDb.nodes.getAllNodes.mockResolvedValue([
      { nodeNum: 1, channel: 0, hideFromMap: false },
      { nodeNum: 2, channel: 0, hideFromMap: true },
    ]);
    mockDb.getUserPermissionSetAsync.mockResolvedValue({
      channel_0: { viewOnMap: true, read: true, write: false },
    });
    mockDb.checkPermissionAsync.mockImplementation((_uid: number, resource: string) =>
      Promise.resolve(resource !== 'nodes_private'),
    );

    const app = createApp(regularUser);
    const res = await request(app).get('/positions?since=0');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].nodeNum).toBe(1);
  });

  // #4163 follow-up — telemetry is not cascade-deleted with its node, so bulk
  // deletes that skip telemetry ("Clean up inactive nodes", "Prune Outside
  // ROI") leave orphaned position rows. They have no node record, hence no
  // marker, so they must not appear as heatmap/trail density for any user.
  it('admin: hides positions for nodes that no longer exist (orphaned telemetry)', async () => {
    const live = { nodeNum: 1, sourceId: 'src-a', latitude: 1, longitude: 1, altitude: null, timestamp: 1000 };
    const orphan = { nodeNum: 2, sourceId: 'src-a', latitude: 2, longitude: 2, altitude: null, timestamp: 1000 };
    mockDb.analysis.getPositions.mockResolvedValue({
      items: [live, orphan], pageSize: 500, hasMore: false, nextCursor: null,
    });
    // Only node 1 still exists; node 2 was deleted but its telemetry remains.
    mockDb.nodes.getAllNodes.mockResolvedValue([
      { nodeNum: 1, channel: 0, hideFromMap: false },
    ]);

    const app = createApp(adminUser);
    const res = await request(app).get('/positions?since=0');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].nodeNum).toBe(1);
  });

  it('regular user: hides positions for nodes that no longer exist (orphaned telemetry)', async () => {
    const live = { nodeNum: 1, sourceId: 'src-a', latitude: 1, longitude: 1, altitude: null, timestamp: 1000 };
    const orphan = { nodeNum: 2, sourceId: 'src-a', latitude: 2, longitude: 2, altitude: null, timestamp: 1000 };
    mockDb.analysis.getPositions.mockResolvedValue({
      items: [live, orphan], pageSize: 500, hasMore: false, nextCursor: null,
    });
    // Only node 1 still exists. Channel 0 has viewOnMap granted, so if the
    // orphan were defaulted onto channel 0 it would leak — assert it doesn't.
    mockDb.nodes.getAllNodes.mockResolvedValue([
      { nodeNum: 1, channel: 0, hideFromMap: false },
    ]);
    mockDb.getUserPermissionSetAsync.mockResolvedValue({
      channel_0: { viewOnMap: true, read: true, write: false },
    });
    mockDb.checkPermissionAsync.mockImplementation((_uid: number, resource: string) =>
      Promise.resolve(resource !== 'nodes_private'),
    );

    const app = createApp(regularUser);
    const res = await request(app).get('/positions?since=0');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].nodeNum).toBe(1);
  });
});

describe('GET /traceroutes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A, SOURCE_B]);
    mockDb.analysis.getTraceroutes = vi.fn().mockResolvedValue({
      items: [], pageSize: 500, hasMore: false, nextCursor: null,
    });
  });

  it('admin queries all enabled sources', async () => {
    const app = createApp(adminUser);
    const res = await request(app).get('/traceroutes?since=0');
    expect(res.status).toBe(200);
    expect(mockDb.analysis.getTraceroutes).toHaveBeenCalledWith(
      expect.objectContaining({ sourceIds: ['src-a', 'src-b'] }),
    );
  });

  it('regular user: filters by traceroute:read permission per source', async () => {
    mockDb.checkPermissionAsync.mockImplementation(
      (_uid: number, resource: string, _a: string, sid: string) =>
        Promise.resolve(resource === 'traceroute' && sid === 'src-a'),
    );
    const app = createApp(regularUser);
    const res = await request(app).get('/traceroutes?since=0');
    expect(res.status).toBe(200);
    expect(mockDb.analysis.getTraceroutes).toHaveBeenCalledWith(
      expect.objectContaining({ sourceIds: ['src-a'] }),
    );
  });

  it('passes through cursor and pageSize', async () => {
    const app = createApp(adminUser);
    await request(app).get('/traceroutes?since=0&cursor=xyz&pageSize=10');
    expect(mockDb.analysis.getTraceroutes).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: 'xyz', pageSize: 10 }),
    );
  });
});

describe('GET /neighbors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A, SOURCE_B]);
    mockDb.analysis.getNeighbors = vi.fn().mockResolvedValue({ items: [] });
  });

  it('admin: returns merged neighbors across all sources', async () => {
    const app = createApp(adminUser);
    const res = await request(app).get('/neighbors?since=0');
    expect(res.status).toBe(200);
    expect(mockDb.analysis.getNeighbors).toHaveBeenCalledWith(
      expect.objectContaining({ sourceIds: ['src-a', 'src-b'] }),
    );
  });

  it('respects intersection with requested sources', async () => {
    mockDb.checkPermissionAsync.mockResolvedValue(true);
    const app = createApp(regularUser);
    await request(app).get('/neighbors?sources=src-a&since=0');
    expect(mockDb.analysis.getNeighbors).toHaveBeenCalledWith(
      expect.objectContaining({ sourceIds: ['src-a'] }),
    );
  });
});

describe('GET /coverage-grid', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A, SOURCE_B]);
    mockDb.analysis.getCoverageGrid.mockResolvedValue({
      cells: [], binSizeDeg: 0.04,
    });
    mockDb.nodes.getAllNodes.mockResolvedValue([]);
    mockDb.getUserPermissionSetAsync.mockResolvedValue({ channel_0: { viewOnMap: true, read: true, write: false } });
    mockDb.getChannelDatabasePermissionsForUserAsSetAsync.mockResolvedValue({});
    mockDb.checkPermissionAsync.mockResolvedValue(true);
  });

  it('admin: queries all enabled sources and forwards zoom', async () => {
    const app = createApp(adminUser);
    const res = await request(app).get('/coverage-grid?since=0&zoom=10');
    expect(res.status).toBe(200);
    expect(mockDb.analysis.getCoverageGrid).toHaveBeenCalledWith(
      expect.objectContaining({ sourceIds: ['src-a', 'src-b'], zoom: 10 }),
    );
  });

  it('admin: serves second request from cache (within TTL)', async () => {
    const app = createApp(adminUser);
    // Use a unique cache key (different sinceMs) to avoid cache pollution
    // from any prior test.
    const url = '/coverage-grid?since=9999&zoom=8';
    await request(app).get(url);
    await request(app).get(url);
    expect(mockDb.analysis.getCoverageGrid).toHaveBeenCalledTimes(1);
  });

  it('non-admin: skips cache and passes postFilter to getCoverageGrid', async () => {
    mockDb.checkPermissionAsync.mockResolvedValue(false);
    const app = createApp(regularUser);
    const url = '/coverage-grid?since=8888&zoom=8';
    await request(app).get(url);
    await request(app).get(url);
    // Result is not cached for non-admin, so getCoverageGrid called twice
    expect(mockDb.analysis.getCoverageGrid).toHaveBeenCalledTimes(2);
    // postFilter should be provided (non-null function)
    const firstCall = mockDb.analysis.getCoverageGrid.mock.calls[0][0];
    expect(typeof firstCall.postFilter).toBe('function');
  });

  // #4162/#4163 — the coverage grid must exclude hidden-node density too. The
  // grid is server-binned, so we assert the postFilter handed to
  // getCoverageGrid drops a hideFromMap node (admin path: display gate only).
  it('admin: coverage-grid postFilter drops hideFromMap nodes', async () => {
    mockDb.nodes.getAllNodes.mockResolvedValue([
      { nodeNum: 1, channel: 0, hideFromMap: false },
      { nodeNum: 2, channel: 0, hideFromMap: true },
    ]);
    const app = createApp(adminUser);
    // Unique cache key so this isn't served from a prior test's cache.
    await request(app).get('/coverage-grid?since=7777&zoom=8');
    const call = mockDb.analysis.getCoverageGrid.mock.calls[0][0];
    expect(typeof call.postFilter).toBe('function');
    expect(call.postFilter({ sourceId: 'src-a', nodeNum: 1 })).toBe(true);
    expect(call.postFilter({ sourceId: 'src-a', nodeNum: 2 })).toBe(false);
  });

  // #4163 follow-up — the coverage grid must also exclude density from
  // orphaned telemetry whose owning node was deleted/pruned.
  it('admin: coverage-grid postFilter drops orphaned (deleted-node) positions', async () => {
    mockDb.nodes.getAllNodes.mockResolvedValue([
      { nodeNum: 1, channel: 0, hideFromMap: false },
    ]);
    const app = createApp(adminUser);
    // Unique cache key so this isn't served from a prior test's cache.
    await request(app).get('/coverage-grid?since=6666&zoom=8');
    const call = mockDb.analysis.getCoverageGrid.mock.calls[0][0];
    expect(typeof call.postFilter).toBe('function');
    // Node 1 still exists → kept; node 2 was deleted (not in getAllNodes) → dropped.
    expect(call.postFilter({ sourceId: 'src-a', nodeNum: 1 })).toBe(true);
    expect(call.postFilter({ sourceId: 'src-a', nodeNum: 2 })).toBe(false);
  });
});

describe('GET /hop-counts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A, SOURCE_B]);
    mockDb.analysis.getHopCounts = vi.fn().mockResolvedValue({ entries: [] });
  });

  it('admin: queries all enabled sources', async () => {
    const app = createApp(adminUser);
    const res = await request(app).get('/hop-counts');
    expect(res.status).toBe(200);
    expect(mockDb.analysis.getHopCounts).toHaveBeenCalledWith(
      expect.objectContaining({ sourceIds: ['src-a', 'src-b'] }),
    );
  });

  it('regular user: filters by nodes:read permission', async () => {
    mockDb.checkPermissionAsync.mockImplementation(
      (_uid: number, resource: string, _a: string, sid: string) =>
        Promise.resolve(resource === 'nodes' && sid === 'src-a'),
    );
    const app = createApp(regularUser);
    const res = await request(app).get('/hop-counts');
    expect(res.status).toBe(200);
    expect(mockDb.analysis.getHopCounts).toHaveBeenCalledWith(
      expect.objectContaining({ sourceIds: ['src-a'] }),
    );
  });
});
