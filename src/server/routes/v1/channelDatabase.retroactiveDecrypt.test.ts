/**
 * v1 channel-database — retroactive decrypt P0 security gate tests (PR-B)
 *
 * The handler is in `_channelDatabaseHandlers.ts`. It enforces a two-stage
 * permission gate:
 *
 * 1. `channel_database:write` on the caller (admin OR explicit grant)
 * 2. `messages:read` on EVERY sourceId that has encrypted, undecoded packets
 *    in `packet_log`. Denials short-circuit with 403 + `deniedSourceIds[]`
 *    and `processForChannel()` is NOT invoked.
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
import { retroactiveDecryptionService } from '../../services/retroactiveDecryptionService.js';

const mockDb = databaseService as any;
const processForChannelMock = retroactiveDecryptionService.processForChannel as any;

const adminUser = { id: 1, username: 'admin', isAdmin: true, isActive: true };
const writerUser = { id: 50, username: 'writer', isAdmin: false, isActive: true };
const noPermsUser = { id: 70, username: 'nobody', isAdmin: false, isActive: true };

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
  app.use('/api/v1/channel-database', channelDatabaseRouter);
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();
  processForChannelMock.mockClear();
  mockDb.channelDatabase.getByIdAsync.mockResolvedValue(channel);
  mockDb.checkPermissionAsync.mockResolvedValue(false);
  mockDb.getDistinctEncryptedPacketSourceIdsAsync.mockResolvedValue([]);
});

describe('POST /:id/retroactive-decrypt — outer gate (channel_database:write)', () => {
  it('caller without :write → 403, no source enumeration, processForChannel NOT invoked', async () => {
    const res = await request(createApp(noPermsUser)).post(
      '/api/v1/channel-database/1/retroactive-decrypt'
    );
    expect(res.status).toBe(403);
    expect(mockDb.getDistinctEncryptedPacketSourceIdsAsync).not.toHaveBeenCalled();
    expect(processForChannelMock).not.toHaveBeenCalled();
  });
});

describe('POST /:id/retroactive-decrypt — inner gate (per-source messages:read)', () => {
  it('writer + messages:read denied on one source → 403 with deniedSourceIds, processForChannel NOT invoked', async () => {
    mockDb.checkPermissionAsync.mockImplementation(
      async (_uid: number, resource: string, action: string, sourceId?: string) => {
        if (resource === 'channel_database' && action === 'write') return true;
        if (resource === 'messages' && action === 'read') {
          // Allow source-A; deny source-B
          return sourceId === 'source-A';
        }
        return false;
      }
    );
    mockDb.getDistinctEncryptedPacketSourceIdsAsync.mockResolvedValue(['source-A', 'source-B']);

    const res = await request(createApp(writerUser)).post(
      '/api/v1/channel-database/1/retroactive-decrypt'
    );

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      success: false,
      error: 'Forbidden',
      code: 'FORBIDDEN_SOURCE_SCOPE',
      deniedSourceIds: ['source-B'],
    });
    expect(processForChannelMock).not.toHaveBeenCalled();
  });

  it('writer + multiple denied sources → all listed in deniedSourceIds', async () => {
    mockDb.checkPermissionAsync.mockImplementation(
      async (_uid: number, resource: string, action: string) => {
        if (resource === 'channel_database' && action === 'write') return true;
        return false; // deny everything else
      }
    );
    mockDb.getDistinctEncryptedPacketSourceIdsAsync.mockResolvedValue(['src-a', 'src-b', 'src-c']);

    const res = await request(createApp(writerUser)).post(
      '/api/v1/channel-database/1/retroactive-decrypt'
    );

    expect(res.status).toBe(403);
    expect(res.body.deniedSourceIds.sort()).toEqual(['src-a', 'src-b', 'src-c']);
    expect(processForChannelMock).not.toHaveBeenCalled();
  });

  it('writer + legacy null sourceId denied → "(legacy-default)" appears in deniedSourceIds', async () => {
    mockDb.checkPermissionAsync.mockImplementation(
      async (_uid: number, resource: string, action: string) => {
        if (resource === 'channel_database' && action === 'write') return true;
        return false;
      }
    );
    mockDb.getDistinctEncryptedPacketSourceIdsAsync.mockResolvedValue([null]);

    const res = await request(createApp(writerUser)).post(
      '/api/v1/channel-database/1/retroactive-decrypt'
    );

    expect(res.status).toBe(403);
    expect(res.body.deniedSourceIds).toContain('(legacy-default)');
    expect(processForChannelMock).not.toHaveBeenCalled();
  });

  it('writer + messages:read on all touched sources → 200, processForChannel invoked once', async () => {
    mockDb.checkPermissionAsync.mockImplementation(
      async (_uid: number, resource: string, action: string) => {
        if (resource === 'channel_database' && action === 'write') return true;
        if (resource === 'messages' && action === 'read') return true;
        return false;
      }
    );
    mockDb.getDistinctEncryptedPacketSourceIdsAsync.mockResolvedValue(['src-a', 'src-b']);

    const res = await request(createApp(writerUser)).post(
      '/api/v1/channel-database/1/retroactive-decrypt'
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(processForChannelMock).toHaveBeenCalledTimes(1);
    expect(processForChannelMock).toHaveBeenCalledWith(1);
  });

  it('admin: bypasses per-source loop, processForChannel invoked once', async () => {
    // Admin: outer gate auto-passes; loop is skipped entirely (admin shortcut).
    mockDb.getDistinctEncryptedPacketSourceIdsAsync.mockResolvedValue(['src-a', 'src-b']);

    const res = await request(createApp(adminUser)).post(
      '/api/v1/channel-database/1/retroactive-decrypt'
    );

    expect(res.status).toBe(200);
    expect(processForChannelMock).toHaveBeenCalledTimes(1);
    expect(processForChannelMock).toHaveBeenCalledWith(1);
    // Admin shortcut should skip the enumeration entirely.
    expect(mockDb.getDistinctEncryptedPacketSourceIdsAsync).not.toHaveBeenCalled();
  });

  it('writer + zero encrypted packets in any source → 200, processForChannel invoked', async () => {
    mockDb.checkPermissionAsync.mockImplementation(
      async (_uid: number, resource: string, action: string) => {
        if (resource === 'channel_database' && action === 'write') return true;
        return false;
      }
    );
    mockDb.getDistinctEncryptedPacketSourceIdsAsync.mockResolvedValue([]);

    const res = await request(createApp(writerUser)).post(
      '/api/v1/channel-database/1/retroactive-decrypt'
    );

    expect(res.status).toBe(200);
    expect(processForChannelMock).toHaveBeenCalledTimes(1);
  });
});

describe('POST /:id/retroactive-decrypt — preconditions', () => {
  it('returns 404 when channel not found', async () => {
    mockDb.channelDatabase.getByIdAsync.mockResolvedValue(null);
    const res = await request(createApp(adminUser)).post(
      '/api/v1/channel-database/999/retroactive-decrypt'
    );
    expect(res.status).toBe(404);
    expect(processForChannelMock).not.toHaveBeenCalled();
  });

  it('returns 400 when channel is disabled', async () => {
    mockDb.channelDatabase.getByIdAsync.mockResolvedValue({ ...channel, isEnabled: false });
    const res = await request(createApp(adminUser)).post(
      '/api/v1/channel-database/1/retroactive-decrypt'
    );
    expect(res.status).toBe(400);
    expect(processForChannelMock).not.toHaveBeenCalled();
  });
});
