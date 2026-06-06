/**
 * sourceRoutes — POST /reorder (issue #3338).
 *
 * Covers admin gating (`sources:write`), payload validation, the happy path,
 * and propagation of the repository's non-permutation guard as a 400.
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
      createSource: vi.fn(),
      updateSource: vi.fn(),
      deleteSource: vi.fn().mockResolvedValue(true),
      reorderSources: vi.fn(),
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
  },
}));

vi.mock('../meshcoreRegistry.js', () => ({
  meshcoreManagerRegistry: {
    get: vi.fn().mockReturnValue(null),
    getOrCreate: vi.fn(),
    remove: vi.fn().mockResolvedValue(undefined),
  },
  meshcoreConfigFromSource: vi.fn().mockReturnValue(null),
}));

const mockDb = databaseService as any;

const adminUser = { id: 1, username: 'admin', isActive: true, isAdmin: true };
const plainUser = { id: 2, username: 'viewer', isActive: true, isAdmin: false };

const createApp = (userId: number): Express => {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false, cookie: { secure: false } }));
  app.use((req: any, _res, next) => {
    req.session.userId = userId;
    next();
  });
  app.use('/', sourceRoutes);
  return app;
};

const sampleSources = [
  { id: 'a', name: 'A', type: 'meshtastic_tcp', enabled: true, displayOrder: 1, config: {}, createdAt: 1, updatedAt: 1, createdBy: null },
  { id: 'b', name: 'B', type: 'meshtastic_tcp', enabled: true, displayOrder: 2, config: {}, createdAt: 2, updatedAt: 2, createdBy: null },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.findUserByIdAsync.mockResolvedValue(adminUser);
  mockDb.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: true });
  mockDb.checkPermissionAsync.mockResolvedValue(true);
});

describe('sourceRoutes — POST /reorder', () => {
  it('reorders sources for an admin and returns the new order', async () => {
    const app = createApp(adminUser.id);
    mockDb.sources.reorderSources.mockResolvedValue([sampleSources[1], sampleSources[0]]);

    const res = await request(app).post('/reorder').send({ order: ['b', 'a'] });

    expect(res.status).toBe(200);
    expect(mockDb.sources.reorderSources).toHaveBeenCalledWith(['b', 'a']);
    expect(res.body.map((s: any) => s.id)).toEqual(['b', 'a']);
  });

  it('rejects a non-array order with 400', async () => {
    const app = createApp(adminUser.id);
    const res = await request(app).post('/reorder').send({ order: 'nope' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/array of source IDs/);
    expect(mockDb.sources.reorderSources).not.toHaveBeenCalled();
  });

  it('rejects an array containing non-strings with 400', async () => {
    const app = createApp(adminUser.id);
    const res = await request(app).post('/reorder').send({ order: ['a', 5] });

    expect(res.status).toBe(400);
    expect(mockDb.sources.reorderSources).not.toHaveBeenCalled();
  });

  it('surfaces the repository non-permutation guard as a 400', async () => {
    const app = createApp(adminUser.id);
    mockDb.sources.reorderSources.mockRejectedValue(
      new Error('orderedIds must contain every source exactly once (expected 2, got 1)')
    );

    const res = await request(app).post('/reorder').send({ order: ['a'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/every source exactly once/);
  });

  it('denies a non-admin without sources:write (403)', async () => {
    mockDb.findUserByIdAsync.mockResolvedValue(plainUser);
    mockDb.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: false });
    mockDb.checkPermissionAsync.mockResolvedValue(false);
    const app = createApp(plainUser.id);

    const res = await request(app).post('/reorder').send({ order: ['b', 'a'] });

    expect(res.status).toBe(403);
    expect(mockDb.sources.reorderSources).not.toHaveBeenCalled();
  });
});
