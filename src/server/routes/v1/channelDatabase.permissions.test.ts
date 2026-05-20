/**
 * v1 channel-database — permission model tests (PR-B)
 *
 * Verifies the inline `checkPermissionAsync` model wired in
 * `_channelDatabaseHandlers.ts`:
 *
 * - admin → full PSK
 * - non-admin with `channel_database:write` → full PSK
 * - non-admin with `channel_database:read` + per-entry canRead → entry visible, PSK masked
 * - non-admin with `channel_database:read` and no per-entry row → entry filtered out / 404
 * - non-admin without `channel_database:read` → 403
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { Express } from 'express';
import request from 'supertest';

vi.mock('../../../services/database.js', () => ({
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

vi.mock('../../services/channelDecryptionService.js', () => ({
  channelDecryptionService: { invalidateCache: vi.fn() },
}));

vi.mock('../../services/retroactiveDecryptionService.js', () => ({
  retroactiveDecryptionService: {
    processForChannel: vi.fn().mockResolvedValue(undefined),
    getProgress: vi.fn().mockReturnValue({ processed: 0, total: 0 }),
    isRunning: vi.fn().mockReturnValue(false),
  },
}));

import channelDatabaseRouter from './channelDatabase.js';
import databaseService from '../../../services/database.js';

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
const channel2 = { ...channel1, id: 2, name: 'Channel 2', psk: Buffer.alloc(16, 0xcd).toString('base64') };

const createApp = (user: any): Express => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = user;
    next();
  });
  app.use('/api/v1/channel-database', channelDatabaseRouter);
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.channelDatabase.getAllAsync.mockResolvedValue([channel1, channel2]);
  mockDb.channelDatabase.getByIdAsync.mockResolvedValue(channel1);
  mockDb.channelDatabase.getPermissionsForUserAsync.mockResolvedValue([]);
  mockDb.channelDatabase.getPermissionAsync.mockResolvedValue(null);
  mockDb.checkPermissionAsync.mockResolvedValue(false);
});

describe('GET / — list with permission filtering', () => {
  it('admin: returns all channels with full PSK', async () => {
    const res = await request(createApp(adminUser)).get('/api/v1/channel-database');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    for (const ch of res.body.data) {
      expect(ch.psk).toBeDefined();
      expect(ch.psk).not.toMatch(/\.\.\.$/);
    }
  });

  it('non-admin with channel_database:write: returns all channels with full PSK', async () => {
    mockDb.checkPermissionAsync.mockImplementation(
      async (_uid: number, resource: string, action: string) =>
        resource === 'channel_database' && action === 'write'
    );
    const res = await request(createApp(writerUser)).get('/api/v1/channel-database');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    for (const ch of res.body.data) {
      expect(ch.psk).toBeDefined();
    }
  });

  it('non-admin with :read + per-entry canRead on channel 1: returns only channel 1 with masked PSK', async () => {
    mockDb.checkPermissionAsync.mockImplementation(
      async (_uid: number, resource: string, action: string) =>
        resource === 'channel_database' && action === 'read'
    );
    mockDb.channelDatabase.getPermissionsForUserAsync.mockResolvedValue([
      { userId: 60, channelDatabaseId: 1, canViewOnMap: false, canRead: true },
      { userId: 60, channelDatabaseId: 2, canViewOnMap: true, canRead: false },
    ]);

    const res = await request(createApp(readerUser)).get('/api/v1/channel-database');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.data[0].id).toBe(1);
    expect(res.body.data[0].psk).toBeUndefined();
    expect(res.body.data[0].pskPreview).toMatch(/\.\.\.$/);
  });

  it('non-admin with :read but no per-entry rows: returns empty list', async () => {
    mockDb.checkPermissionAsync.mockImplementation(
      async (_uid: number, resource: string, action: string) =>
        resource === 'channel_database' && action === 'read'
    );
    mockDb.channelDatabase.getPermissionsForUserAsync.mockResolvedValue([]);
    const res = await request(createApp(readerUser)).get('/api/v1/channel-database');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
  });

  it('non-admin without channel_database:read: returns 403', async () => {
    mockDb.checkPermissionAsync.mockResolvedValue(false);
    const res = await request(createApp(noPermsUser)).get('/api/v1/channel-database');
    expect(res.status).toBe(403);
  });
});

describe('GET /:id — single-entry permission filtering', () => {
  it('admin: returns channel with full PSK', async () => {
    const res = await request(createApp(adminUser)).get('/api/v1/channel-database/1');
    expect(res.status).toBe(200);
    expect(res.body.data.psk).toBeDefined();
  });

  it('non-admin with :write: returns channel with full PSK', async () => {
    mockDb.checkPermissionAsync.mockImplementation(
      async (_uid: number, resource: string, action: string) =>
        resource === 'channel_database' && action === 'write'
    );
    const res = await request(createApp(writerUser)).get('/api/v1/channel-database/1');
    expect(res.status).toBe(200);
    expect(res.body.data.psk).toBeDefined();
  });

  it('non-admin with :read + per-entry canRead: returns channel, PSK masked', async () => {
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
    const res = await request(createApp(readerUser)).get('/api/v1/channel-database/1');
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(1);
    expect(res.body.data.psk).toBeUndefined();
    expect(res.body.data.pskPreview).toMatch(/\.\.\.$/);
  });

  it('non-admin with :read but no per-entry row: returns 404 (entry hidden)', async () => {
    mockDb.checkPermissionAsync.mockImplementation(
      async (_uid: number, resource: string, action: string) =>
        resource === 'channel_database' && action === 'read'
    );
    mockDb.channelDatabase.getPermissionAsync.mockResolvedValue(null);
    const res = await request(createApp(readerUser)).get('/api/v1/channel-database/1');
    expect(res.status).toBe(404);
  });

  it('non-admin with :read + per-entry canRead=false: returns 404 (entry hidden)', async () => {
    mockDb.checkPermissionAsync.mockImplementation(
      async (_uid: number, resource: string, action: string) =>
        resource === 'channel_database' && action === 'read'
    );
    mockDb.channelDatabase.getPermissionAsync.mockResolvedValue({
      userId: 60,
      channelDatabaseId: 1,
      canViewOnMap: true,
      canRead: false,
    });
    const res = await request(createApp(readerUser)).get('/api/v1/channel-database/1');
    expect(res.status).toBe(404);
  });

  it('non-admin without :read: returns 403', async () => {
    const res = await request(createApp(noPermsUser)).get('/api/v1/channel-database/1');
    expect(res.status).toBe(403);
  });
});

describe('Write endpoints — require channel_database:write', () => {
  it('POST / → 403 for non-admin without :write', async () => {
    mockDb.checkPermissionAsync.mockResolvedValue(false);
    const res = await request(createApp(readerUser))
      .post('/api/v1/channel-database')
      .send({ name: 'New', psk: fakePsk });
    expect(res.status).toBe(403);
  });

  it('POST / → 201 for non-admin with :write', async () => {
    mockDb.checkPermissionAsync.mockImplementation(
      async (_uid: number, resource: string, action: string) =>
        resource === 'channel_database' && action === 'write'
    );
    mockDb.channelDatabase.createAsync.mockResolvedValue(99);
    mockDb.channelDatabase.getByIdAsync.mockResolvedValue({ ...channel1, id: 99 });
    const res = await request(createApp(writerUser))
      .post('/api/v1/channel-database')
      .send({ name: 'New', psk: fakePsk });
    expect(res.status).toBe(201);
    expect(mockDb.channelDatabase.createAsync).toHaveBeenCalledOnce();
  });

  it('PUT /:id/permissions/:userId → 403 for :read-only user', async () => {
    mockDb.checkPermissionAsync.mockImplementation(
      async (_uid: number, resource: string, action: string) =>
        resource === 'channel_database' && action === 'read'
    );
    const res = await request(createApp(readerUser))
      .put('/api/v1/channel-database/1/permissions/10')
      .send({ canViewOnMap: true, canRead: true });
    expect(res.status).toBe(403);
  });
});
