/**
 * Waypoint route tests
 *
 * Mounts the router with a parent /api/sources/:id/waypoints prefix so
 * `requirePermission('waypoints', …, sourceIdFrom: 'params.id')` resolves
 * the same way it does in production via sourceRoutes.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { Express, Router } from 'express';
import session from 'express-session';
import request from 'supertest';
import waypointRoutes from './waypoints.js';
import databaseService from '../../services/database.js';

vi.mock('../../services/database.js', () => ({
  default: {
    drizzleDbType: 'sqlite',
    findUserByIdAsync: vi.fn(),
    findUserByUsernameAsync: vi.fn(),
    checkPermissionAsync: vi.fn(),
    getUserPermissionSetAsync: vi.fn(),
    sources: {
      getSource: vi.fn(),
    },
    waypoints: {
      getAsync: vi.fn(),
      listAsync: vi.fn(),
      upsertAsync: vi.fn(),
      deleteAsync: vi.fn(),
      getExistingIdsAsync: vi.fn(),
      sweepExpiredAsync: vi.fn(),
    },
  },
}));

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn(),
  },
}));

vi.mock('../services/waypointService.js', () => ({
  waypointService: {
    list: vi.fn(),
    get: vi.fn(),
    createLocal: vi.fn(),
    update: vi.fn(),
    deleteLocal: vi.fn(),
    expireSweep: vi.fn(),
  },
}));

const mockDb = databaseService as unknown as {
  findUserByIdAsync: ReturnType<typeof vi.fn>;
  findUserByUsernameAsync: ReturnType<typeof vi.fn>;
  checkPermissionAsync: ReturnType<typeof vi.fn>;
  sources: { getSource: ReturnType<typeof vi.fn> };
  waypoints: {
    getAsync: ReturnType<typeof vi.fn>;
    listAsync: ReturnType<typeof vi.fn>;
    upsertAsync: ReturnType<typeof vi.fn>;
    deleteAsync: ReturnType<typeof vi.fn>;
    getExistingIdsAsync: ReturnType<typeof vi.fn>;
    sweepExpiredAsync: ReturnType<typeof vi.fn>;
  };
};

const adminUser = { id: 1, username: 'admin', isActive: true, isAdmin: true };
const regularUser = { id: 2, username: 'user', isActive: true, isAdmin: false };

function createApp(opts: { authenticated?: boolean; admin?: boolean } = {}): Express {
  const { authenticated = true, admin = true } = opts;
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

  if (authenticated) {
    app.use((req, _res, next) => {
      req.session.userId = admin ? adminUser.id : regularUser.id;
      req.session.username = admin ? adminUser.username : regularUser.username;
      next();
    });
  }

  mockDb.findUserByIdAsync.mockResolvedValue(admin ? adminUser : regularUser);
  mockDb.findUserByUsernameAsync.mockResolvedValue(null);

  // Match production wiring: parent router with :id, child waypoints router.
  const sourceRouter = Router();
  sourceRouter.use('/:id/waypoints', waypointRoutes);
  app.use('/api/sources', sourceRouter);
  return app;
}

import { waypointService } from '../services/waypointService.js';
const mockWaypointService = waypointService as unknown as {
  list: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  createLocal: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  deleteLocal: ReturnType<typeof vi.fn>;
};

describe('Waypoint routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.checkPermissionAsync.mockResolvedValue(true);
    mockDb.sources.getSource.mockResolvedValue({ id: 'src-1', name: 'Default' });
  });

  describe('GET /api/sources/:id/waypoints', () => {
    it('returns the list for an authorised user', async () => {
      const sample = [
        { sourceId: 'src-1', waypointId: 1, name: 'A', latitude: 30, longitude: -90 },
      ];
      mockWaypointService.list.mockResolvedValue(sample);
      const app = createApp({ admin: false });

      const res = await request(app).get('/api/sources/src-1/waypoints');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: sample });
      expect(mockWaypointService.list).toHaveBeenCalledWith('src-1', expect.any(Object));
    });

    it('returns 401 when unauthenticated', async () => {
      const app = createApp({ authenticated: false });
      const res = await request(app).get('/api/sources/src-1/waypoints');
      expect(res.status).toBe(401);
    });

    it('returns 403 when permission check fails', async () => {
      mockDb.checkPermissionAsync.mockResolvedValue(false);
      const app = createApp({ admin: false });
      const res = await request(app).get('/api/sources/src-1/waypoints');
      expect(res.status).toBe(403);
    });

    it('returns 404 when the source does not exist', async () => {
      mockDb.sources.getSource.mockResolvedValue(null);
      const app = createApp();
      const res = await request(app).get('/api/sources/src-1/waypoints');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/sources/:id/waypoints', () => {
    it('creates a waypoint with valid input', async () => {
      mockWaypointService.createLocal.mockResolvedValue({
        sourceId: 'src-1',
        waypointId: 99,
        latitude: 30,
        longitude: -90,
        name: 'Test',
      });
      const app = createApp();

      const res = await request(app)
        .post('/api/sources/src-1/waypoints')
        .send({ lat: 30, lon: -90, name: 'Test', virtual: true });

      expect(res.status).toBe(201);
      expect(res.body.data.waypointId).toBe(99);
      expect(mockWaypointService.createLocal).toHaveBeenCalled();
    });

    it('rejects invalid coordinates with 400', async () => {
      const app = createApp();
      const res = await request(app)
        .post('/api/sources/src-1/waypoints')
        .send({ lat: 999, lon: -90 });
      expect(res.status).toBe(400);
    });

    it('rejects missing coordinates with 400', async () => {
      const app = createApp();
      const res = await request(app)
        .post('/api/sources/src-1/waypoints')
        .send({ name: 'no coords' });
      expect(res.status).toBe(400);
    });

    it('returns 403 for users without write permission', async () => {
      mockDb.checkPermissionAsync.mockResolvedValue(false);
      const app = createApp({ admin: false });
      const res = await request(app)
        .post('/api/sources/src-1/waypoints')
        .send({ lat: 30, lon: -90 });
      expect(res.status).toBe(403);
    });
  });

  describe('PATCH /api/sources/:id/waypoints/:waypointId', () => {
    it('returns 403 when waypoint is locked to another node', async () => {
      mockWaypointService.update.mockRejectedValue(new Error('waypoint 1 is locked to 999'));
      const app = createApp();
      const res = await request(app)
        .patch('/api/sources/src-1/waypoints/1')
        .send({ name: 'edit' });
      expect(res.status).toBe(403);
    });
  });

  describe('DELETE /api/sources/:id/waypoints/:waypointId', () => {
    it('deletes when waypoint exists', async () => {
      mockDb.waypoints.getAsync.mockResolvedValue({
        sourceId: 'src-1',
        waypointId: 1,
        isVirtual: true,
      });
      mockWaypointService.deleteLocal.mockResolvedValue(true);
      const app = createApp();
      const res = await request(app).delete('/api/sources/src-1/waypoints/1');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('returns 404 when waypoint missing', async () => {
      mockDb.waypoints.getAsync.mockResolvedValue(null);
      const app = createApp();
      const res = await request(app).delete('/api/sources/src-1/waypoints/1');
      expect(res.status).toBe(404);
    });
  });
});
