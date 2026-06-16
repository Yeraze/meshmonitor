import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { Express } from 'express';
import session from 'express-session';
import request from 'supertest';
import cleanupRoutes from './cleanupRoutes.js';
import databaseService from '../../services/database.js';

vi.mock('../../services/database.js', () => ({
  default: {
    drizzleDbType: 'sqlite',
    findUserByIdAsync: vi.fn(),
    findUserByUsernameAsync: vi.fn(),
    checkPermissionAsync: vi.fn(),
    getUserPermissionSetAsync: vi.fn(),
    cleanupOldMessagesAsync: vi.fn(),
    cleanupInactiveNodesAsync: vi.fn(),
    cleanupInvalidChannelsAsync: vi.fn(),
  },
}));

const mockDb = databaseService as unknown as {
  findUserByIdAsync: ReturnType<typeof vi.fn>;
  findUserByUsernameAsync: ReturnType<typeof vi.fn>;
  checkPermissionAsync: ReturnType<typeof vi.fn>;
  getUserPermissionSetAsync: ReturnType<typeof vi.fn>;
  cleanupOldMessagesAsync: ReturnType<typeof vi.fn>;
  cleanupInactiveNodesAsync: ReturnType<typeof vi.fn>;
  cleanupInvalidChannelsAsync: ReturnType<typeof vi.fn>;
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
  app.use('/cleanup', cleanupRoutes);
  return app;
};

describe('Cleanup Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.findUserByUsernameAsync.mockResolvedValue(null);
    mockDb.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: false });
  });

  describe('authentication', () => {
    it('POST /cleanup/messages returns 401 when unauthenticated', async () => {
      const app = createApp();
      const res = await request(app).post('/cleanup/messages');
      expect(res.status).toBe(401);
    });

    it('POST /cleanup/nodes returns 401 when unauthenticated', async () => {
      const app = createApp();
      const res = await request(app).post('/cleanup/nodes');
      expect(res.status).toBe(401);
    });

    it('POST /cleanup/channels returns 401 when unauthenticated', async () => {
      const app = createApp();
      const res = await request(app).post('/cleanup/channels');
      expect(res.status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('POST /cleanup/messages returns 403 for non-admin', async () => {
      mockDb.findUserByIdAsync.mockResolvedValue(regularUser);
      mockDb.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: false });
      const app = createApp(regularUser.id);
      const res = await request(app).post('/cleanup/messages').send({ days: 30 });
      expect(res.status).toBe(403);
    });
  });

  describe('POST /cleanup/messages', () => {
    it('deletes old messages and returns count', async () => {
      mockDb.findUserByIdAsync.mockResolvedValue(adminUser);
      mockDb.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: true });
      mockDb.cleanupOldMessagesAsync.mockResolvedValue(42);
      const app = createApp(adminUser.id, true);
      const res = await request(app).post('/cleanup/messages').send({ days: 7 });
      expect(res.status).toBe(200);
      expect(res.body.deletedCount).toBe(42);
      expect(mockDb.cleanupOldMessagesAsync).toHaveBeenCalledWith(7, undefined);
    });

    it('defaults to 30 days when days not specified', async () => {
      mockDb.findUserByIdAsync.mockResolvedValue(adminUser);
      mockDb.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: true });
      mockDb.cleanupOldMessagesAsync.mockResolvedValue(0);
      const app = createApp(adminUser.id, true);
      await request(app).post('/cleanup/messages').send({});
      expect(mockDb.cleanupOldMessagesAsync).toHaveBeenCalledWith(30, undefined);
    });
  });

  describe('POST /cleanup/nodes', () => {
    it('deletes inactive nodes and returns count', async () => {
      mockDb.findUserByIdAsync.mockResolvedValue(adminUser);
      mockDb.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: true });
      mockDb.cleanupInactiveNodesAsync.mockResolvedValue(10);
      const app = createApp(adminUser.id, true);
      const res = await request(app).post('/cleanup/nodes').send({ days: 14, sourceId: 'src1' });
      expect(res.status).toBe(200);
      expect(res.body.deletedCount).toBe(10);
      expect(mockDb.cleanupInactiveNodesAsync).toHaveBeenCalledWith(14, 'src1');
    });
  });

  describe('POST /cleanup/channels', () => {
    it('deletes invalid channels and returns count', async () => {
      mockDb.findUserByIdAsync.mockResolvedValue(adminUser);
      mockDb.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: true });
      mockDb.cleanupInvalidChannelsAsync.mockResolvedValue(3);
      const app = createApp(adminUser.id, true);
      const res = await request(app).post('/cleanup/channels').send({ sourceId: 'src1' });
      expect(res.status).toBe(200);
      expect(res.body.deletedCount).toBe(3);
      expect(mockDb.cleanupInvalidChannelsAsync).toHaveBeenCalledWith('src1');
    });
  });
});
