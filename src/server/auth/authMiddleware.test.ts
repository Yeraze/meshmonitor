/**
 * authMiddleware — requirePermission per-source scoping unit tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { Express } from 'express';
import session from 'express-session';
import request from 'supertest';
import databaseService from '../../services/database.js';
import { requirePermission } from './authMiddleware.js';

vi.mock('../../services/database.js', () => ({
  default: {
    findUserByIdAsync: vi.fn(),
    findUserByUsernameAsync: vi.fn(),
    checkPermissionAsync: vi.fn(),
    getUserPermissionSetAsync: vi.fn(),
  }
}));

const mockDb = databaseService as any;

const normalUser = { id: 42, username: 'normal', isActive: true, isAdmin: false };

const buildApp = (mw: ReturnType<typeof requirePermission>): Express => {
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
  const handler = (req: any, res: any) => {
    res.json({ ok: true, scopedSourceId: req.scopedSourceId ?? null });
  };
  app.all('/test', mw, handler);
  app.all('/test/:id', mw, handler);
  return app;
};

describe('requirePermission middleware — per-source scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.findUserByIdAsync.mockResolvedValue(normalUser);
    mockDb.findUserByUsernameAsync.mockResolvedValue(null);
    mockDb.checkPermissionAsync.mockResolvedValue(true);
  });

  it('without sourceIdFrom: passes undefined sourceId to checkPermissionAsync', async () => {
    const app = buildApp(requirePermission('messages', 'read'));
    const res = await request(app).get('/test/anything');
    expect(res.status).toBe(200);
    expect(mockDb.checkPermissionAsync).toHaveBeenCalledWith(42, 'messages', 'read', undefined);
    expect(res.body.scopedSourceId).toBeNull();
  });

  it('sourceIdFrom: params.id extracts from req.params.id and sets scopedSourceId', async () => {
    const app = buildApp(requirePermission('messages', 'read', { sourceIdFrom: 'params.id' }));
    const res = await request(app).get('/test/srcA');
    expect(res.status).toBe(200);
    expect(mockDb.checkPermissionAsync).toHaveBeenCalledWith(42, 'messages', 'read', 'srcA');
    expect(res.body.scopedSourceId).toBe('srcA');
  });

  it('sourceIdFrom: query extracts from req.query.sourceId', async () => {
    const app = buildApp(requirePermission('nodes', 'read', { sourceIdFrom: 'query' }));
    const res = await request(app).get('/test/x').query({ sourceId: 'srcQ' });
    expect(res.status).toBe(200);
    expect(mockDb.checkPermissionAsync).toHaveBeenCalledWith(42, 'nodes', 'read', 'srcQ');
  });

  it('sourceIdFrom: body extracts from req.body.sourceId', async () => {
    const app = buildApp(requirePermission('traceroute', 'read', { sourceIdFrom: 'body' }));
    const res = await request(app).post('/test/x').send({ sourceId: 'srcB' });
    expect(res.status).toBe(200);
    expect(mockDb.checkPermissionAsync).toHaveBeenCalledWith(42, 'traceroute', 'read', 'srcB');
  });

  it('returns 403 when checkPermissionAsync returns false for that source', async () => {
    mockDb.checkPermissionAsync.mockResolvedValue(false);
    const app = buildApp(requirePermission('messages', 'read', { sourceIdFrom: 'params.id' }));
    const res = await request(app).get('/test/srcDenied');
    expect(res.status).toBe(403);
  });

  it('allows when source-specific grant exists even if global denies', async () => {
    mockDb.checkPermissionAsync.mockImplementation(
      (_uid: number, _r: string, _a: string, sourceId?: string) => Promise.resolve(sourceId === 'allowed-src')
    );
    const appAllowed = buildApp(requirePermission('messages', 'read', { sourceIdFrom: 'params.id' }));
    const okRes = await request(appAllowed).get('/test/allowed-src');
    expect(okRes.status).toBe(200);

    const appDenied = buildApp(requirePermission('messages', 'read', { sourceIdFrom: 'params.id' }));
    const denyRes = await request(appDenied).get('/test/other-src');
    expect(denyRes.status).toBe(403);
  });

  it('rejects non-string sourceId in query with 400', async () => {
    const app = buildApp(requirePermission('messages', 'read', { sourceIdFrom: 'query' }));
    const res = await request(app).get('/test/x?sourceId=a&sourceId=b');
    expect(res.status).toBe(400);
  });
});
