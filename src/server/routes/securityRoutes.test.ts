import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { Express } from 'express';
import session from 'express-session';
import request from 'supertest';

// Mock database service and registry BEFORE importing the route
vi.mock('../../services/database.js', () => ({
  default: {
    drizzleDbType: 'sqlite',
    // authMiddleware deps
    findUserByIdAsync: vi.fn(),
    findUserByUsernameAsync: vi.fn(),
    checkPermissionAsync: vi.fn(),
    getUserPermissionSetAsync: vi.fn(),
    // security route deps
    auditLogAsync: vi.fn().mockResolvedValue(undefined),
    getNodesWithKeySecurityIssuesAsync: vi.fn().mockResolvedValue([]),
    getNodesWithExcessivePacketsAsync: vi.fn().mockResolvedValue([]),
    getNodesWithTimeOffsetIssuesAsync: vi.fn().mockResolvedValue([]),
    getTopBroadcastersAsync: vi.fn().mockResolvedValue([]),
    nodes: { getAllNodes: vi.fn().mockResolvedValue([]), getNode: vi.fn() },
    settings: { getSetting: vi.fn().mockResolvedValue(null) },
    getKeyRepairLogAsync: vi.fn().mockResolvedValue([]),
  }
}));

const h = vi.hoisted(() => ({
  runScanMock: vi.fn().mockResolvedValue(undefined),
  getStatusMock: vi.fn(),
  getManagerMock: vi.fn(),
  getAllManagersMock: vi.fn(),
}));
const { runScanMock, getStatusMock, getManagerMock, getAllManagersMock } = h;

vi.mock('../services/duplicateKeySchedulerService.js', () => ({
  duplicateKeySchedulerService: {
    runScan: h.runScanMock,
    getStatus: h.getStatusMock,
  }
}));

vi.mock('../services/securityDigestService.js', () => ({
  securityDigestService: { sendDigest: vi.fn().mockResolvedValue({ success: true, message: 'ok' }) }
}));

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: h.getManagerMock,
    getAllManagers: h.getAllManagersMock,
  }
}));

import databaseService from '../../services/database.js';
import securityRoutes from './securityRoutes.js';

const mockDb = databaseService as any;

const defaultUser = { id: 1, username: 'tester', isActive: true, isAdmin: false };

function createApp(permissionFn: (u: number, r: string, a: string, sid?: string) => boolean = () => true): Express {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => { (req.session as any).userId = defaultUser.id; next(); });

  mockDb.findUserByIdAsync.mockResolvedValue(defaultUser);
  mockDb.findUserByUsernameAsync.mockResolvedValue(null);
  mockDb.checkPermissionAsync.mockImplementation(async (u: number, r: string, a: string, sid?: string) => {
    return permissionFn(u, r, a, sid);
  });
  mockDb.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: false });

  app.use('/api/security', securityRoutes);
  return app;
}

describe('securityRoutes — per-source scanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runScanMock.mockResolvedValue(undefined);
    getAllManagersMock.mockReturnValue([
      { sourceId: 'src-1' },
      { sourceId: 'src-2' },
    ]);
    getManagerMock.mockImplementation((id: string) =>
      ['src-1', 'src-2'].includes(id) ? { sourceId: id } : undefined
    );
    getStatusMock.mockImplementation((sid?: string) => {
      if (sid) {
        return { running: true, scanningNow: false, intervalHours: 24, lastScanTime: null };
      }
      return {
        running: true,
        intervalHours: 24,
        sources: {
          'src-1': { scanningNow: false, lastScanTime: null },
          'src-2': { scanningNow: false, lastScanTime: null },
        }
      };
    });
  });

  describe('POST /scanner/scan', () => {
    it('returns 400 without sourceId', async () => {
      const app = createApp();
      const res = await request(app).post('/api/security/scanner/scan').send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/sourceId/);
      expect(runScanMock).not.toHaveBeenCalled();
    });

    it('returns 403 without security:write permission on that source', async () => {
      const app = createApp((_u, _r, a, sid) => {
        if (a === 'read') return true;
        return sid !== 'src-1';
      });
      const res = await request(app).post('/api/security/scanner/scan').send({ sourceId: 'src-1' });
      expect(res.status).toBe(403);
      expect(runScanMock).not.toHaveBeenCalled();
    });

    it('returns 200 and runs scan only for the requested source', async () => {
      const app = createApp((_u, _r, a, sid) => a === 'read' || sid === 'src-1');
      const res = await request(app).post('/api/security/scanner/scan').send({ sourceId: 'src-1' });
      expect(res.status).toBe(200);
      expect(res.body.sourceId).toBe('src-1');
      // Allow the fire-and-forget scan to schedule
      await new Promise(r => setImmediate(r));
      expect(runScanMock).toHaveBeenCalledTimes(1);
      expect(runScanMock).toHaveBeenCalledWith('src-1');
    });

    it('returns 400 for unknown sourceId', async () => {
      const app = createApp();
      const res = await request(app).post('/api/security/scanner/scan').send({ sourceId: 'bogus' });
      expect(res.status).toBe(400);
      expect(runScanMock).not.toHaveBeenCalled();
    });
  });

  describe('GET /scanner/status', () => {
    it('returns per-source map when no sourceId supplied', async () => {
      const app = createApp();
      const res = await request(app).get('/api/security/scanner/status');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('sources');
      expect(res.body.sources).toHaveProperty('src-1');
      expect(res.body.sources).toHaveProperty('src-2');
    });

    it('returns single-source status when sourceId supplied', async () => {
      const app = createApp();
      const res = await request(app).get('/api/security/scanner/status?sourceId=src-1');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('scanningNow');
      expect(res.body).not.toHaveProperty('sources');
      expect(getStatusMock).toHaveBeenCalledWith('src-1');
    });
  });
});
