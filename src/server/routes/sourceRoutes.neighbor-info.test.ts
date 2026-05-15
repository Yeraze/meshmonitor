/**
 * Source Routes — neighbor-info endpoint tests
 *
 * Tests GET /api/sources/:id/neighbor-info
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
    neighbors: {
      getAllNeighborInfo: vi.fn(),
    },
    nodes: {
      getNode: vi.fn(),
      getNodesByNums: vi.fn(),
    },
    settings: {
      getSetting: vi.fn(),
    },
    checkPermissionAsync: vi.fn(),
    findUserByIdAsync: vi.fn(),
    findUserByUsernameAsync: vi.fn(),
    getUserPermissionSetAsync: vi.fn(),
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

const adminUser = { id: 1, username: 'admin', isActive: true, isAdmin: true };

const createApp = (user: any = adminUser): Express => {
  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
      cookie: { secure: false }
    })
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

const MOCK_SOURCE = { id: 'src-abc', name: 'Test Source', type: 'meshtastic_tcp', enabled: true };

// Returns a unix timestamp seconds "now"
const nowSec = () => Math.floor(Date.now() / 1000);

const makeNeighborRecord = (overrides: any = {}) => ({
  id: 1,
  nodeNum: 111,
  neighborNodeNum: 222,
  snr: -5.5,
  lastRxTime: null,
  // Stored as ms in the DB write path (meshtasticManager uses Date.now())
  timestamp: Date.now(),
  sourceId: 'src-abc',
  ...overrides,
});

const makeNode = (nodeNum: number, overrides: any = {}) => ({
  nodeId: `!${nodeNum.toString(16).padStart(8, '0')}`,
  nodeNum,
  longName: `Node ${nodeNum}`,
  latitude: 37.0 + nodeNum * 0.001,
  longitude: -122.0 + nodeNum * 0.001,
  lastHeard: nowSec(),
  positionOverrideEnabled: false,
  latitudeOverride: null,
  longitudeOverride: null,
  ...overrides,
});

describe('GET /:id/neighbor-info', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.findUserByIdAsync.mockResolvedValue(adminUser);
    mockDb.findUserByUsernameAsync.mockResolvedValue(null);
    mockDb.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: true });
    mockDb.checkPermissionAsync.mockResolvedValue(true);
    mockDb.settings.getSetting.mockResolvedValue(null); // default 24h
  });

  it('returns 404 when source does not exist', async () => {
    mockDb.sources.getSource.mockResolvedValue(null);

    const res = await request(createApp()).get('/nonexistent/neighbor-info');

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'Source not found' });
  });

  it('returns empty array when no neighbor records exist', async () => {
    mockDb.sources.getSource.mockResolvedValue(MOCK_SOURCE);
    mockDb.neighbors.getAllNeighborInfo.mockResolvedValue([]);
    mockDb.nodes.getNodesByNums.mockResolvedValue(new Map());

    const res = await request(createApp()).get('/src-abc/neighbor-info');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(mockDb.neighbors.getAllNeighborInfo).toHaveBeenCalledWith('src-abc');
  });

  it('enriches records with node names, positions, and bidirectionality', async () => {
    const ni1 = makeNeighborRecord({ nodeNum: 111, neighborNodeNum: 222 });
    const ni2 = makeNeighborRecord({ id: 2, nodeNum: 222, neighborNodeNum: 111 }); // bidirectional

    mockDb.sources.getSource.mockResolvedValue(MOCK_SOURCE);
    mockDb.neighbors.getAllNeighborInfo.mockResolvedValue([ni1, ni2]);
    mockDb.nodes.getNodesByNums.mockImplementation(async (nums: number[]) =>
      new Map(nums.map(n => [n, makeNode(n)]))
    );

    const res = await request(createApp()).get('/src-abc/neighbor-info');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);

    const first = res.body[0];
    expect(first.nodeId).toBe('!0000006f');
    expect(first.nodeName).toBe('Node 111');
    expect(first.neighborNodeId).toBe('!000000de');
    expect(first.neighborName).toBe('Node 222');
    expect(first.bidirectional).toBe(true);
    expect(typeof first.nodeLatitude).toBe('number');
    expect(typeof first.nodeLongitude).toBe('number');
    expect(typeof first.neighborLatitude).toBe('number');
    expect(typeof first.neighborLongitude).toBe('number');
    // Ensure internal node/neighbor objects are stripped
    expect(first.node).toBeUndefined();
    expect(first.neighbor).toBeUndefined();
  });

  it('marks bidirectional=false when reverse link is absent', async () => {
    const ni = makeNeighborRecord({ nodeNum: 111, neighborNodeNum: 333 });

    mockDb.sources.getSource.mockResolvedValue(MOCK_SOURCE);
    mockDb.neighbors.getAllNeighborInfo.mockResolvedValue([ni]);
    mockDb.nodes.getNodesByNums.mockImplementation(async (nums: number[]) =>
      new Map(nums.map(n => [n, makeNode(n)]))
    );

    const res = await request(createApp()).get('/src-abc/neighbor-info');

    expect(res.status).toBe(200);
    expect(res.body[0].bidirectional).toBe(false);
  });

  it('filters out records where the reporter lastHeard is older than maxNodeAge', async () => {
    const staleTime = nowSec() - 30 * 60 * 60; // 30 hours ago — beyond default 24h
    const ni = makeNeighborRecord({ nodeNum: 111, neighborNodeNum: 222 });

    mockDb.sources.getSource.mockResolvedValue(MOCK_SOURCE);
    mockDb.neighbors.getAllNeighborInfo.mockResolvedValue([ni]);
    // reporter (111) is stale — we haven't heard from them recently, so we can't
    // trust the link even if the NeighborInfo row in the DB is otherwise recent.
    mockDb.nodes.getNodesByNums.mockImplementation(async (nums: number[]) =>
      new Map(nums.map(n => [n, n === 111 ? makeNode(n, { lastHeard: staleTime }) : makeNode(n)]))
    );

    const res = await request(createApp()).get('/src-abc/neighbor-info');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('filters out records where the reporter node has no lastHeard', async () => {
    const ni = makeNeighborRecord({ nodeNum: 111, neighborNodeNum: 222 });

    mockDb.sources.getSource.mockResolvedValue(MOCK_SOURCE);
    mockDb.neighbors.getAllNeighborInfo.mockResolvedValue([ni]);
    // reporter (111) has null lastHeard — we never heard from them directly
    mockDb.nodes.getNodesByNums.mockImplementation(async (nums: number[]) =>
      new Map(nums.map(n => [n, n === 111 ? makeNode(n, { lastHeard: null }) : makeNode(n)]))
    );

    const res = await request(createApp()).get('/src-abc/neighbor-info');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('keeps records where the neighbor has null lastHeard but the NeighborInfo report is fresh', async () => {
    // Regression for #3025: PR #2615 intentionally leaves lastHeard=NULL on placeholder
    // nodes we've only heard *about* via NeighborInfo. Those links must not be dropped
    // when the NeighborInfo report itself is recent.
    const ni = makeNeighborRecord({ nodeNum: 111, neighborNodeNum: 222 });

    mockDb.sources.getSource.mockResolvedValue(MOCK_SOURCE);
    mockDb.neighbors.getAllNeighborInfo.mockResolvedValue([ni]);
    mockDb.nodes.getNodesByNums.mockImplementation(async (nums: number[]) =>
      new Map(nums.map(n => [n, n === 222 ? makeNode(n, { lastHeard: null }) : makeNode(n)]))
    );

    const res = await request(createApp()).get('/src-abc/neighbor-info');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].nodeNum).toBe(111);
    expect(res.body[0].neighborNodeNum).toBe(222);
  });

  it('filters out records when neighbor lastHeard is null AND the NeighborInfo report is stale', async () => {
    // 48 hours ago, in ms — beyond the default 24h window
    const staleMs = Date.now() - 48 * 60 * 60 * 1000;
    const ni = makeNeighborRecord({
      nodeNum: 111,
      neighborNodeNum: 222,
      timestamp: staleMs,
      lastRxTime: null,
    });

    mockDb.sources.getSource.mockResolvedValue(MOCK_SOURCE);
    mockDb.neighbors.getAllNeighborInfo.mockResolvedValue([ni]);
    mockDb.nodes.getNodesByNums.mockImplementation(async (nums: number[]) =>
      new Map(nums.map(n => [n, n === 222 ? makeNode(n, { lastHeard: null }) : makeNode(n)]))
    );

    const res = await request(createApp()).get('/src-abc/neighbor-info');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('keeps records when neighbor lastHeard is null but lastRxTime (seconds) is fresh', async () => {
    // Stale NI report row timestamp but recent firmware-supplied lastRxTime
    const staleMs = Date.now() - 48 * 60 * 60 * 1000;
    const ni = makeNeighborRecord({
      nodeNum: 111,
      neighborNodeNum: 222,
      timestamp: staleMs,
      lastRxTime: nowSec(), // firmware time, seconds
    });

    mockDb.sources.getSource.mockResolvedValue(MOCK_SOURCE);
    mockDb.neighbors.getAllNeighborInfo.mockResolvedValue([ni]);
    mockDb.nodes.getNodesByNums.mockImplementation(async (nums: number[]) =>
      new Map(nums.map(n => [n, n === 222 ? makeNode(n, { lastHeard: null }) : makeNode(n)]))
    );

    const res = await request(createApp()).get('/src-abc/neighbor-info');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('uses positionOverride when positionOverrideEnabled is true', async () => {
    const ni = makeNeighborRecord({ nodeNum: 111, neighborNodeNum: 222 });

    mockDb.sources.getSource.mockResolvedValue(MOCK_SOURCE);
    mockDb.neighbors.getAllNeighborInfo.mockResolvedValue([ni]);
    mockDb.nodes.getNodesByNums.mockImplementation(async (nums: number[]) =>
      new Map(nums.map(n => [
        n,
        n === 111
          ? makeNode(n, { positionOverrideEnabled: true, latitudeOverride: 99.5, longitudeOverride: -88.5 })
          : makeNode(n),
      ]))
    );

    const res = await request(createApp()).get('/src-abc/neighbor-info');

    expect(res.status).toBe(200);
    expect(res.body[0].nodeLatitude).toBe(99.5);
    expect(res.body[0].nodeLongitude).toBe(-88.5);
  });

  it('uses custom maxNodeAge from settings', async () => {
    // maxNodeAge = 1 hour; stale reporter is 2 hours old
    const staleTime = nowSec() - 2 * 60 * 60;
    const ni = makeNeighborRecord({ nodeNum: 111, neighborNodeNum: 222 });

    mockDb.sources.getSource.mockResolvedValue(MOCK_SOURCE);
    mockDb.neighbors.getAllNeighborInfo.mockResolvedValue([ni]);
    mockDb.settings.getSetting.mockResolvedValue('1'); // 1-hour window
    // Reporter (111) is stale relative to the custom 1-hour window
    mockDb.nodes.getNodesByNums.mockImplementation(async (nums: number[]) =>
      new Map(nums.map(n => [n, n === 111 ? makeNode(n, { lastHeard: staleTime }) : makeNode(n)]))
    );

    const res = await request(createApp()).get('/src-abc/neighbor-info');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('falls back to hex node ID when node has no nodeId or longName', async () => {
    const ni = makeNeighborRecord({ nodeNum: 0xabcdef01, neighborNodeNum: 0x12345678 });

    mockDb.sources.getSource.mockResolvedValue(MOCK_SOURCE);
    mockDb.neighbors.getAllNeighborInfo.mockResolvedValue([ni]);
    // Return nodes that pass the age filter but have no nodeId/longName
    mockDb.nodes.getNodesByNums.mockImplementation(async (nums: number[]) =>
      new Map(nums.map(n => [n, makeNode(n, { nodeId: null, longName: null })]))
    );

    const res = await request(createApp()).get('/src-abc/neighbor-info');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].nodeId).toBe('!abcdef01');
    expect(res.body[0].nodeName).toBe('Node !abcdef01');
    expect(res.body[0].neighborNodeId).toBe('!12345678');
    expect(res.body[0].neighborName).toBe('Node !12345678');
  });

  it('returns 403 for unauthenticated requests', async () => {
    mockDb.findUserByIdAsync.mockResolvedValue(null);
    mockDb.checkPermissionAsync.mockResolvedValue(false);
    mockDb.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: false });

    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
    app.use('/', sourceRoutes);

    const res = await request(app).get('/src-abc/neighbor-info');
    expect([401, 403]).toContain(res.status);
  });
});
