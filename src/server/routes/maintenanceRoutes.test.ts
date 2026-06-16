import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { Express } from 'express';
import session from 'express-session';
import request from 'supertest';
import maintenanceRoutes from './maintenanceRoutes.js';
import databaseService from '../../services/database.js';

vi.mock('../../services/database.js', () => ({
  default: {
    drizzleDbType: 'sqlite',
    findUserByIdAsync: vi.fn(),
    findUserByUsernameAsync: vi.fn(),
    checkPermissionAsync: vi.fn(),
    getUserPermissionSetAsync: vi.fn(),
  },
}));

vi.mock('../services/databaseMaintenanceService.js', () => ({
  databaseMaintenanceService: {
    getStatus: vi.fn(),
    getDatabaseSizeAsync: vi.fn(),
    formatBytes: vi.fn((n: number) => `${n} B`),
    runMaintenance: vi.fn(),
  },
}));

import { databaseMaintenanceService } from '../services/databaseMaintenanceService.js';

const mockDb = databaseService as unknown as {
  findUserByIdAsync: ReturnType<typeof vi.fn>;
  findUserByUsernameAsync: ReturnType<typeof vi.fn>;
  checkPermissionAsync: ReturnType<typeof vi.fn>;
  getUserPermissionSetAsync: ReturnType<typeof vi.fn>;
};

const mockMaintenance = databaseMaintenanceService as unknown as {
  getStatus: ReturnType<typeof vi.fn>;
  getDatabaseSizeAsync: ReturnType<typeof vi.fn>;
  formatBytes: ReturnType<typeof vi.fn>;
  runMaintenance: ReturnType<typeof vi.fn>;
};

const adminUser = { id: 1, username: 'admin', isActive: true, isAdmin: true };
const regularUser = { id: 2, username: 'user', isActive: true, isAdmin: false };

const createApp = (userId?: number, isAdmin = false): Express => {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test', resave: false, saveUninitialized: false, cookie: { secure: false } }));
  if (userId !== undefined) {
    app.use((req, _res, next) => {
      req.session.userId = userId;
      next();
    });
  }
  app.use('/maintenance', maintenanceRoutes);
  return app;
};

describe('Maintenance Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.findUserByUsernameAsync.mockResolvedValue(null);
  });

  describe('GET /maintenance/status', () => {
    it('returns 401 when unauthenticated', async () => {
      const app = createApp();
      const res = await request(app).get('/maintenance/status');
      expect(res.status).toBe(401);
    });

    it('returns 403 when user lacks configuration:read', async () => {
      mockDb.findUserByIdAsync.mockResolvedValue(regularUser);
      mockDb.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: false });
      const app = createApp(regularUser.id);
      const res = await request(app).get('/maintenance/status');
      expect(res.status).toBe(403);
    });

    it('returns maintenance status for permitted user', async () => {
      mockDb.findUserByIdAsync.mockResolvedValue(adminUser);
      mockDb.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: true });
      const mockStatus = { running: false, enabled: true, lastRunTime: null };
      mockMaintenance.getStatus.mockResolvedValue(mockStatus);
      const app = createApp(adminUser.id);
      const res = await request(app).get('/maintenance/status');
      expect(res.status).toBe(200);
      expect(res.body).toEqual(mockStatus);
    });
  });

  describe('GET /maintenance/size', () => {
    it('returns database size for permitted user', async () => {
      mockDb.findUserByIdAsync.mockResolvedValue(adminUser);
      mockDb.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: true });
      mockMaintenance.getDatabaseSizeAsync.mockResolvedValue(1024);
      mockMaintenance.formatBytes.mockReturnValue('1.00 KB');
      const app = createApp(adminUser.id);
      const res = await request(app).get('/maintenance/size');
      expect(res.status).toBe(200);
      expect(res.body.size).toBe(1024);
      expect(res.body.formatted).toBe('1.00 KB');
    });
  });

  describe('POST /maintenance/run', () => {
    it('runs maintenance and returns stats', async () => {
      mockDb.findUserByIdAsync.mockResolvedValue(adminUser);
      mockDb.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: true });
      const stats = {
        messagesDeleted: 10,
        traceroutesDeleted: 5,
        routeSegmentsDeleted: 3,
        neighborInfoDeleted: 2,
        sizeBefore: 2048,
        sizeAfter: 1024,
        duration: 100,
        timestamp: '2024-01-01',
      };
      mockMaintenance.runMaintenance.mockResolvedValue(stats);
      mockMaintenance.formatBytes.mockReturnValue('1.00 KB');
      const app = createApp(adminUser.id);
      const res = await request(app).post('/maintenance/run');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.stats).toEqual(stats);
    });
  });
});
