/**
 * Legacy session-mount channel-database — retroactive decrypt P0 gate (PR-B mirror)
 *
 * Parity coverage for the legacy mount. The handler is shared with v1 via
 * `_channelDatabaseHandlers.ts` — these tests lock in that the legacy mount
 * enforces the same per-source ACL pre-flight.
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
import { retroactiveDecryptionService } from '../services/retroactiveDecryptionService.js';

const mockDb = databaseService as any;
const processForChannelMock = retroactiveDecryptionService.processForChannel as any;

const adminUser = { id: 1, username: 'admin', isAdmin: true, isActive: true };
const writerUser = { id: 50, username: 'writer', isAdmin: false, isActive: true };

const channel = {
  id: 1,
  name: 'Channel 1',
  psk: Buffer.alloc(16, 0xab).toString('base64'),
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
  processForChannelMock.mockClear();
  mockDb.channelDatabase.getByIdAsync.mockResolvedValue(channel);
  mockDb.checkPermissionAsync.mockResolvedValue(false);
  mockDb.getDistinctEncryptedPacketSourceIdsAsync.mockResolvedValue([]);
});

describe('Legacy mount — POST /:id/retroactive-decrypt', () => {
  it('writer + denied messages:read on a source → 403 with deniedSourceIds; processForChannel NOT invoked', async () => {
    mockDb.checkPermissionAsync.mockImplementation(
      async (_uid: number, resource: string, action: string, sourceId?: string) => {
        if (resource === 'channel_database' && action === 'write') return true;
        if (resource === 'messages' && action === 'read') return sourceId === 'source-A';
        return false;
      }
    );
    mockDb.getDistinctEncryptedPacketSourceIdsAsync.mockResolvedValue(['source-A', 'source-B']);

    const res = await request(createApp(writerUser)).post(
      '/api/channel-database/1/retroactive-decrypt'
    );

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_SOURCE_SCOPE');
    expect(res.body.deniedSourceIds).toEqual(['source-B']);
    expect(processForChannelMock).not.toHaveBeenCalled();
  });

  it('writer + full access → 200; processForChannel invoked once with channel id', async () => {
    mockDb.checkPermissionAsync.mockImplementation(
      async (_uid: number, resource: string, action: string) => {
        if (resource === 'channel_database' && action === 'write') return true;
        if (resource === 'messages' && action === 'read') return true;
        return false;
      }
    );
    mockDb.getDistinctEncryptedPacketSourceIdsAsync.mockResolvedValue(['src-a']);

    const res = await request(createApp(writerUser)).post(
      '/api/channel-database/1/retroactive-decrypt'
    );

    expect(res.status).toBe(200);
    expect(processForChannelMock).toHaveBeenCalledTimes(1);
    expect(processForChannelMock).toHaveBeenCalledWith(1);
  });

  it('admin: shortcut → 200, source enumeration NOT invoked', async () => {
    const res = await request(createApp(adminUser)).post(
      '/api/channel-database/1/retroactive-decrypt'
    );
    expect(res.status).toBe(200);
    expect(mockDb.getDistinctEncryptedPacketSourceIdsAsync).not.toHaveBeenCalled();
    expect(processForChannelMock).toHaveBeenCalledTimes(1);
  });
});
