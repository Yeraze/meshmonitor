import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { Express } from 'express';
import session from 'express-session';
import request from 'supertest';
import purgeRoutes from './purgeRoutes.js';
import databaseService from '../../services/database.js';

vi.mock('../../services/database.js', () => ({
  default: {
    drizzleDbType: 'sqlite',
    findUserByIdAsync: vi.fn(),
    findUserByUsernameAsync: vi.fn(),
    checkPermissionAsync: vi.fn(),
    getUserPermissionSetAsync: vi.fn(),
    auditLogAsync: vi.fn(),
    nodes: { getNodeCount: vi.fn() },
    purgeAllNodesAsync: vi.fn(),
    purgeAllTelemetryAsync: vi.fn(),
    messages: { getMessageCount: vi.fn(), deleteAllMessages: vi.fn() },
    traceroutes: { deleteAllTraceroutes: vi.fn(), deleteAllRouteSegments: vi.fn() },
  },
}));

const mockManager = { refreshNodeDatabase: vi.fn() };
vi.mock('../utils/resolveSourceManager.js', () => ({
  resolveSourceManager: vi.fn(() => mockManager),
}));

const mockDb = databaseService as unknown as {
  findUserByIdAsync: ReturnType<typeof vi.fn>;
  findUserByUsernameAsync: ReturnType<typeof vi.fn>;
  checkPermissionAsync: ReturnType<typeof vi.fn>;
  getUserPermissionSetAsync: ReturnType<typeof vi.fn>;
  auditLogAsync: ReturnType<typeof vi.fn>;
  nodes: { getNodeCount: ReturnType<typeof vi.fn> };
  purgeAllNodesAsync: ReturnType<typeof vi.fn>;
  purgeAllTelemetryAsync: ReturnType<typeof vi.fn>;
  messages: { getMessageCount: ReturnType<typeof vi.fn>; deleteAllMessages: ReturnType<typeof vi.fn> };
  traceroutes: { deleteAllTraceroutes: ReturnType<typeof vi.fn>; deleteAllRouteSegments: ReturnType<typeof vi.fn> };
};

const adminUser = { id: 1, username: 'admin', isActive: true, isAdmin: true };
const regularUser = { id: 2, username: 'user', isActive: true, isAdmin: false };

const createApp = (userId?: number): Express => {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test', resave: false, saveUninitialized: false, cookie: { secure: false } }));
  if (userId !== undefined) {
    app.use((req, _res, next) => {
      req.session.userId = userId;
      next();
    });
  }
  app.use('/purge', purgeRoutes);
  return app;
};

describe('Purge Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.findUserByUsernameAsync.mockResolvedValue(null);
    mockDb.auditLogAsync.mockResolvedValue(undefined);
    mockDb.nodes.getNodeCount.mockResolvedValue(0);
    mockDb.purgeAllNodesAsync.mockResolvedValue(undefined);
    mockManager.refreshNodeDatabase.mockResolvedValue(undefined);
    mockDb.purgeAllTelemetryAsync.mockResolvedValue(undefined);
    mockDb.messages.getMessageCount.mockResolvedValue(0);
    mockDb.messages.deleteAllMessages.mockResolvedValue(undefined);
    mockDb.traceroutes.deleteAllTraceroutes.mockResolvedValue(undefined);
    mockDb.traceroutes.deleteAllRouteSegments.mockResolvedValue(undefined);
  });

  describe('authentication and authorization', () => {
    it('returns 401 for unauthenticated requests', async () => {
      const app = createApp();
      const res = await request(app).post('/purge/nodes');
      expect(res.status).toBe(401);
    });

    it('returns 403 for non-admin users', async () => {
      mockDb.findUserByIdAsync.mockResolvedValue(regularUser);
      mockDb.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: false });
      const app = createApp(regularUser.id);
      const res = await request(app).post('/purge/nodes');
      expect(res.status).toBe(403);
    });
  });

  describe('POST /purge/nodes', () => {
    it('purges nodes and triggers refresh', async () => {
      mockDb.findUserByIdAsync.mockResolvedValue(adminUser);
      mockDb.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: true });
      const app = createApp(adminUser.id);
      const res = await request(app).post('/purge/nodes').send({});
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockDb.purgeAllNodesAsync).toHaveBeenCalled();
      expect(mockManager.refreshNodeDatabase).toHaveBeenCalled();
    });
  });

  describe('POST /purge/telemetry', () => {
    it('purges all telemetry', async () => {
      mockDb.findUserByIdAsync.mockResolvedValue(adminUser);
      mockDb.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: true });
      const app = createApp(adminUser.id);
      const res = await request(app).post('/purge/telemetry').send({});
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockDb.purgeAllTelemetryAsync).toHaveBeenCalled();
    });
  });

  describe('POST /purge/messages', () => {
    it('purges all messages', async () => {
      mockDb.findUserByIdAsync.mockResolvedValue(adminUser);
      mockDb.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: true });
      mockDb.messages.getMessageCount.mockResolvedValue(100);
      const app = createApp(adminUser.id);
      const res = await request(app).post('/purge/messages').send({});
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockDb.messages.deleteAllMessages).toHaveBeenCalled();
    });
  });

  describe('POST /purge/traceroutes', () => {
    it('purges all traceroutes and route segments', async () => {
      mockDb.findUserByIdAsync.mockResolvedValue(adminUser);
      mockDb.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: true });
      const app = createApp(adminUser.id);
      const res = await request(app).post('/purge/traceroutes').send({});
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockDb.traceroutes.deleteAllTraceroutes).toHaveBeenCalled();
      expect(mockDb.traceroutes.deleteAllRouteSegments).toHaveBeenCalled();
    });
  });
});
