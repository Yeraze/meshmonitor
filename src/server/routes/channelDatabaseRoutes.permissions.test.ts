/**
 * Legacy session-mount channel-database — permission model tests (PR-B mirror)
 *
 * Parity coverage for the `/api/channel-database` mount. Both v1 (Bearer-token)
 * and legacy (browser-session) mounts share `_channelDatabaseHandlers.ts`, so
 * the same permission logic must hold here.
 *
 * The `requireAuth()` middleware is mocked to a passthrough — these tests
 * exercise handler logic, not auth-token validation.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { Express } from 'express';
import request from 'supertest';

vi.mock('../auth/authMiddleware.js', () => ({
  requireAuth: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../services/database.js', () => ({
  default: {
    channelDatabase: {
      getAllAsync: vi.fn(),
      getByIdAsync: vi.fn(),
      getPermissionsForUserAsync: vi.fn(),
      getPermissionAsync: vi.fn(),
      getPermissionsForChannelAsync: vi.fn(),
      createAsync: vi.fn(),
      updateAsync: vi.fn(),
      deleteAsync: vi.fn(),
      reorderAsync: vi.fn(),
      setPermissionAsync: vi.fn(),
      deletePermissionAsync: vi.fn(),
    },
    findUserByIdAsync: vi.fn(),
    checkPermissionAsync: vi.fn(),
    getDistinctEncryptedPacketSourceIdsAsync: vi.fn(),
    drizzleDbType: 'sqlite',
  },
}));

vi.mock('../services/channelDecryptionService.js', () => ({
  channelDecryptionService: { invalidateCache: vi.fn() },
}));

vi.mock('../services/retroactiveDecryptionService.js', () => ({
  retroactiveDecryptionService: {
    processForChannel: vi.fn().mockResolvedValue(undefined),
    getProgress: vi.fn().mockReturnValue({ processed: 0, total: 0 }),
    isRunning: vi.fn().mockReturnValue(false),
  },
}));

import channelDatabaseRoutes from './channelDatabaseRoutes.js';
import databaseService from '../../services/database.js';

const mockDb = databaseService as any;

const adminUser = { id: 1, username: 'admin', isAdmin: true, isActive: true };
const writerUser = { id: 50, username: 'writer', isAdmin: false, isActive: true };
const readerUser = { id: 60, username: 'reader', isAdmin: false, isActive: true };
const noPermsUser = { id: 70, username: 'nobody', isAdmin: false, isActive: true };

const fakePsk = Buffer.alloc(16, 0xab).toString('base64');
const channel1 = {
  id: 1,
  name: 'Channel 1',
  psk: fakePsk,
  pskLength: 16,
  description: null,
  isEnabled: true,
  enforceNameValidation: false,
  sortOrder: 0,
  decryptedPacketCount: 0,
  lastDecryptedAt: null,
  createdBy: 1,
  createdAt: 1000,
  updatedAt: 1000,
};

const createApp = (user: any): Express => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = user;
    next();
  });
  app.use('/api/channel-database', channelDatabaseRoutes);
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.channelDatabase.getAllAsync.mockResolvedValue([channel1]);
  mockDb.channelDatabase.getByIdAsync.mockResolvedValue(channel1);
  mockDb.channelDatabase.getPermissionsForUserAsync.mockResolvedValue([]);
  mockDb.channelDatabase.getPermissionAsync.mockResolvedValue(null);
  mockDb.checkPermissionAsync.mockResolvedValue(false);
});

describe('Legacy mount — GET / permission filtering', () => {
  it('admin: returns channels with full PSK', async () => {
    const res = await request(createApp(adminUser)).get('/api/channel-database');
    expect(res.status).toBe(200);
    expect(res.body.data[0].psk).toBeDefined();
  });

  it('non-admin with :read + per-entry canRead: returns entry with masked PSK', async () => {
    mockDb.checkPermissionAsync.mockImplementation(
      async (_uid: number, resource: string, action: string) =>
        resource === 'channel_database' && action === 'read'
    );
    mockDb.channelDatabase.getPermissionsForUserAsync.mockResolvedValue([
      { userId: 60, channelDatabaseId: 1, canViewOnMap: false, canRead: true },
    ]);
    const res = await request(createApp(readerUser)).get('/api/channel-database');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.data[0].psk).toBeUndefined();
    expect(res.body.data[0].pskPreview).toMatch(/\.\.\.$/);
  });

  it('non-admin without :read: returns 403', async () => {
    const res = await request(createApp(noPermsUser)).get('/api/channel-database');
    expect(res.status).toBe(403);
  });
});

describe('Legacy mount — GET /:id permission filtering', () => {
  it('non-admin with :read + per-entry canRead: returns channel with masked PSK', async () => {
    mockDb.checkPermissionAsync.mockImplementation(
      async (_uid: number, resource: string, action: string) =>
        resource === 'channel_database' && action === 'read'
    );
    mockDb.channelDatabase.getPermissionAsync.mockResolvedValue({
      userId: 60,
      channelDatabaseId: 1,
      canViewOnMap: false,
      canRead: true,
    });
    const res = await request(createApp(readerUser)).get('/api/channel-database/1');
    expect(res.status).toBe(200);
    expect(res.body.data.psk).toBeUndefined();
    expect(res.body.data.pskPreview).toMatch(/\.\.\.$/);
  });

  it('non-admin with :read but no per-entry row: returns 404', async () => {
    mockDb.checkPermissionAsync.mockImplementation(
      async (_uid: number, resource: string, action: string) =>
        resource === 'channel_database' && action === 'read'
    );
    const res = await request(createApp(readerUser)).get('/api/channel-database/1');
    expect(res.status).toBe(404);
  });

  it('non-admin without :read: returns 403', async () => {
    const res = await request(createApp(noPermsUser)).get('/api/channel-database/1');
    expect(res.status).toBe(403);
  });
});

describe('Legacy mount — Write endpoints require channel_database:write', () => {
  it('POST / → 403 for :read-only user', async () => {
    mockDb.checkPermissionAsync.mockImplementation(
      async (_uid: number, resource: string, action: string) =>
        resource === 'channel_database' && action === 'read'
    );
    const res = await request(createApp(readerUser))
      .post('/api/channel-database')
      .send({ name: 'X', psk: fakePsk });
    expect(res.status).toBe(403);
  });

  it('POST / → 201 for non-admin with :write', async () => {
    mockDb.checkPermissionAsync.mockImplementation(
      async (_uid: number, resource: string, action: string) =>
        resource === 'channel_database' && action === 'write'
    );
    mockDb.channelDatabase.createAsync.mockResolvedValue(42);
    mockDb.channelDatabase.getByIdAsync.mockResolvedValue({ ...channel1, id: 42 });
    const res = await request(createApp(writerUser))
      .post('/api/channel-database')
      .send({ name: 'X', psk: fakePsk });
    expect(res.status).toBe(201);
  });
});
