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
    analysis: { getPositions: vi.fn() },
    checkPermissionAsync: vi.fn(),
    findUserByIdAsync: vi.fn(),
    findUserByUsernameAsync: vi.fn(),
    getUserPermissionSetAsync: vi.fn(),
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
    mockDb.analysis.getCoverageGrid = vi.fn().mockResolvedValue({
      cells: [], binSizeDeg: 0.04,
    });
  });

  it('admin: queries all enabled sources and forwards zoom', async () => {
    const app = createApp(adminUser);
    const res = await request(app).get('/coverage-grid?since=0&zoom=10');
    expect(res.status).toBe(200);
    expect(mockDb.analysis.getCoverageGrid).toHaveBeenCalledWith(
      expect.objectContaining({ sourceIds: ['src-a', 'src-b'], zoom: 10 }),
    );
  });

  it('serves second request from cache (within TTL)', async () => {
    const app = createApp(adminUser);
    // Use a unique cache key (different sinceMs) to avoid cache pollution
    // from any prior test.
    const url = '/coverage-grid?since=42&zoom=8';
    await request(app).get(url);
    await request(app).get(url);
    expect(mockDb.analysis.getCoverageGrid).toHaveBeenCalledTimes(1);
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
