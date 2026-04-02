import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { Express } from 'express';
import request from 'supertest';
import channelDatabaseRouter from './channelDatabase.js';
import databaseService from '../../../services/database.js';

vi.mock('../../../services/database.js', () => ({
  default: {
    channelDatabase: {
      getAllAsync: vi.fn(),
      getByIdAsync: vi.fn(),
      createAsync: vi.fn(),
      updateAsync: vi.fn(),
      deleteAsync: vi.fn(),
      reorderAsync: vi.fn(),
      getPermissionsForChannelAsync: vi.fn(),
      setPermissionAsync: vi.fn(),
      deletePermissionAsync: vi.fn(),
    },
    findUserByIdAsync: vi.fn(),
    findUserByUsernameAsync: vi.fn(),
    checkPermissionAsync: vi.fn(),
    getUserPermissionSetAsync: vi.fn(),
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

// expandShorthandPsk: identity for any buffer with length > 0; return null for zero-length
vi.mock('../../constants/meshtastic.js', () => ({
  expandShorthandPsk: vi.fn((buf: Buffer) => (buf.length === 0 ? null : buf)),
}));

const mockDb = databaseService as any;

const adminUser = { id: 1, username: 'admin', isAdmin: true, isActive: true };
const regularUser = { id: 2, username: 'user', isAdmin: false, isActive: true };

const validPsk16 = Buffer.alloc(16, 0xff).toString('base64'); // 16-byte AES-128
const validPsk32 = Buffer.alloc(32, 0xaa).toString('base64'); // 32-byte AES-256

const mockChannel = {
  id: 1,
  name: 'Test Channel',
  psk: validPsk16,
  pskLength: 16,
  description: 'A test channel',
  isEnabled: true,
  enforceNameValidation: false,
  sortOrder: 0,
  decryptedPacketCount: 0,
  lastDecryptedAt: null,
  createdBy: 1,
  createdAt: 1000000,
  updatedAt: 1000000,
};

const createApp = (user: any = null): Express => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = user;
    next();
  });
  app.use('/api/v1/channel-database', channelDatabaseRouter);
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.channelDatabase.getAllAsync.mockResolvedValue([mockChannel]);
  mockDb.channelDatabase.getByIdAsync.mockResolvedValue(mockChannel);
  mockDb.channelDatabase.createAsync.mockResolvedValue(1);
  mockDb.channelDatabase.updateAsync.mockResolvedValue(undefined);
  mockDb.channelDatabase.deleteAsync.mockResolvedValue(undefined);
  mockDb.channelDatabase.reorderAsync.mockResolvedValue(undefined);
  mockDb.channelDatabase.getPermissionsForChannelAsync.mockResolvedValue([]);
  mockDb.channelDatabase.setPermissionAsync.mockResolvedValue(undefined);
  mockDb.channelDatabase.deletePermissionAsync.mockResolvedValue(undefined);
  mockDb.findUserByIdAsync.mockResolvedValue({ id: 99, username: 'targetuser' });
});

// ─── GET / ──────────────────────────────────────────────────────────────────

describe('GET /api/v1/channel-database', () => {
  it('returns 403 for non-admin users', async () => {
    const res = await request(createApp(regularUser)).get('/api/v1/channel-database');
    expect(res.status).toBe(403);
  });

  it('returns 403 when no user', async () => {
    const res = await request(createApp(null)).get('/api/v1/channel-database');
    expect(res.status).toBe(403);
  });

  it('returns channels for admin', async () => {
    const res = await request(createApp(adminUser)).get('/api/v1/channel-database');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBe(1);
    expect(res.body.data[0].id).toBe(1);
    expect(res.body.data[0].psk).toBeDefined(); // admin sees full PSK
  });
});

// ─── GET /retroactive-decrypt/progress ─────────────────────────────────────

describe('GET /api/v1/channel-database/retroactive-decrypt/progress', () => {
  it('returns 403 for non-admin', async () => {
    const res = await request(createApp(regularUser)).get(
      '/api/v1/channel-database/retroactive-decrypt/progress',
    );
    expect(res.status).toBe(403);
  });

  it('returns progress for admin', async () => {
    const res = await request(createApp(adminUser)).get(
      '/api/v1/channel-database/retroactive-decrypt/progress',
    );
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body).toHaveProperty('isRunning');
    expect(res.body).toHaveProperty('progress');
  });
});

// ─── GET /:id ───────────────────────────────────────────────────────────────

describe('GET /api/v1/channel-database/:id', () => {
  it('returns 400 for invalid id', async () => {
    const res = await request(createApp(adminUser)).get('/api/v1/channel-database/abc');
    expect(res.status).toBe(400);
  });

  it('returns 403 for non-admin', async () => {
    const res = await request(createApp(regularUser)).get('/api/v1/channel-database/1');
    expect(res.status).toBe(403);
  });

  it('returns 404 when channel not found', async () => {
    mockDb.channelDatabase.getByIdAsync.mockResolvedValue(null);
    const res = await request(createApp(adminUser)).get('/api/v1/channel-database/99');
    expect(res.status).toBe(404);
  });

  it('returns channel for admin', async () => {
    const res = await request(createApp(adminUser)).get('/api/v1/channel-database/1');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(1);
  });
});

// ─── POST / ─────────────────────────────────────────────────────────────────

describe('POST /api/v1/channel-database', () => {
  it('returns 403 for non-admin', async () => {
    const res = await request(createApp(regularUser))
      .post('/api/v1/channel-database')
      .send({ name: 'New', psk: validPsk16 });
    expect(res.status).toBe(403);
  });

  it('returns 400 when name is missing', async () => {
    const res = await request(createApp(adminUser))
      .post('/api/v1/channel-database')
      .send({ psk: validPsk16 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/name is required/);
  });

  it('returns 400 when psk is missing', async () => {
    const res = await request(createApp(adminUser))
      .post('/api/v1/channel-database')
      .send({ name: 'New Channel' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/psk is required/);
  });

  it('returns 400 when psk is not valid base64', async () => {
    const res = await request(createApp(adminUser))
      .post('/api/v1/channel-database')
      .send({ name: 'New', psk: '!!!notbase64!!!' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when PSK length is wrong (not 1, 16, or 32)', async () => {
    // 8-byte PSK — not 1, 16, or 32 bytes
    const shortPsk = Buffer.alloc(8, 0x01).toString('base64');
    const res = await request(createApp(adminUser))
      .post('/api/v1/channel-database')
      .send({ name: 'New', psk: shortPsk });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/16 bytes|32 bytes/);
  });

  it('creates channel with shorthand PSK AQ== and stores it verbatim', async () => {
    const res = await request(createApp(adminUser))
      .post('/api/v1/channel-database')
      .send({ name: 'Default Key Channel', psk: 'AQ==' });
    expect(res.status).toBe(201);
    expect(mockDb.channelDatabase.createAsync).toHaveBeenCalledWith(
      expect.objectContaining({ psk: 'AQ==', pskLength: 1 }),
    );
  });

  it('creates channel and returns 201 for admin with valid PSK', async () => {
    const res = await request(createApp(adminUser))
      .post('/api/v1/channel-database')
      .send({ name: 'New Channel', psk: validPsk16 });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(mockDb.channelDatabase.createAsync).toHaveBeenCalledOnce();
  });

  it('creates channel with 32-byte AES-256 PSK', async () => {
    const res = await request(createApp(adminUser))
      .post('/api/v1/channel-database')
      .send({ name: 'AES-256 Channel', psk: validPsk32 });
    expect(res.status).toBe(201);
  });
});

// ─── PUT /reorder ───────────────────────────────────────────────────────────

describe('PUT /api/v1/channel-database/reorder', () => {
  it('returns 403 for non-admin', async () => {
    const res = await request(createApp(regularUser))
      .put('/api/v1/channel-database/reorder')
      .send({ channels: [{ id: 1, sortOrder: 0 }] });
    expect(res.status).toBe(403);
  });

  it('returns 400 when channels is not an array', async () => {
    const res = await request(createApp(adminUser))
      .put('/api/v1/channel-database/reorder')
      .send({ channels: 'not-an-array' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when channels array is empty', async () => {
    const res = await request(createApp(adminUser))
      .put('/api/v1/channel-database/reorder')
      .send({ channels: [] });
    expect(res.status).toBe(400);
  });

  it('returns 400 when entry has invalid id type', async () => {
    const res = await request(createApp(adminUser))
      .put('/api/v1/channel-database/reorder')
      .send({ channels: [{ id: 'abc', sortOrder: 0 }] });
    expect(res.status).toBe(400);
  });

  it('returns 200 for valid reorder request', async () => {
    const res = await request(createApp(adminUser))
      .put('/api/v1/channel-database/reorder')
      .send({ channels: [{ id: 1, sortOrder: 0 }, { id: 2, sortOrder: 1 }] });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockDb.channelDatabase.reorderAsync).toHaveBeenCalledOnce();
  });
});

// ─── PUT /:id ────────────────────────────────────────────────────────────────

describe('PUT /api/v1/channel-database/:id', () => {
  it('returns 400 for invalid id', async () => {
    const res = await request(createApp(adminUser))
      .put('/api/v1/channel-database/abc')
      .send({ name: 'Updated' });
    expect(res.status).toBe(400);
  });

  it('returns 403 for non-admin', async () => {
    const res = await request(createApp(regularUser))
      .put('/api/v1/channel-database/1')
      .send({ name: 'Updated' });
    expect(res.status).toBe(403);
  });

  it('returns 404 when channel not found', async () => {
    mockDb.channelDatabase.getByIdAsync.mockResolvedValue(null);
    const res = await request(createApp(adminUser))
      .put('/api/v1/channel-database/99')
      .send({ name: 'Updated' });
    expect(res.status).toBe(404);
  });

  it('returns 400 when no valid update fields provided', async () => {
    const res = await request(createApp(adminUser))
      .put('/api/v1/channel-database/1')
      .send({});
    expect(res.status).toBe(400);
  });

  it('updates channel name and returns 200', async () => {
    const updatedChannel = { ...mockChannel, name: 'Updated Name' };
    mockDb.channelDatabase.getByIdAsync
      .mockResolvedValueOnce(mockChannel) // existence check
      .mockResolvedValueOnce(updatedChannel); // after update
    const res = await request(createApp(adminUser))
      .put('/api/v1/channel-database/1')
      .send({ name: 'Updated Name' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockDb.channelDatabase.updateAsync).toHaveBeenCalledOnce();
  });

  it('returns 400 when sortOrder is not an integer', async () => {
    const res = await request(createApp(adminUser))
      .put('/api/v1/channel-database/1')
      .send({ sortOrder: 1.5 });
    expect(res.status).toBe(400);
  });
});

// ─── DELETE /:id ─────────────────────────────────────────────────────────────

describe('DELETE /api/v1/channel-database/:id', () => {
  it('returns 400 for invalid id', async () => {
    const res = await request(createApp(adminUser)).delete('/api/v1/channel-database/abc');
    expect(res.status).toBe(400);
  });

  it('returns 403 for non-admin', async () => {
    const res = await request(createApp(regularUser)).delete('/api/v1/channel-database/1');
    expect(res.status).toBe(403);
  });

  it('returns 404 when channel not found', async () => {
    mockDb.channelDatabase.getByIdAsync.mockResolvedValue(null);
    const res = await request(createApp(adminUser)).delete('/api/v1/channel-database/99');
    expect(res.status).toBe(404);
  });

  it('deletes channel and returns 200', async () => {
    const res = await request(createApp(adminUser)).delete('/api/v1/channel-database/1');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockDb.channelDatabase.deleteAsync).toHaveBeenCalledWith(1);
  });
});

// ─── POST /:id/retroactive-decrypt ──────────────────────────────────────────

describe('POST /api/v1/channel-database/:id/retroactive-decrypt', () => {
  it('returns 403 for non-admin', async () => {
    const res = await request(createApp(regularUser)).post(
      '/api/v1/channel-database/1/retroactive-decrypt',
    );
    expect(res.status).toBe(403);
  });

  it('returns 404 when channel not found', async () => {
    mockDb.channelDatabase.getByIdAsync.mockResolvedValue(null);
    const res = await request(createApp(adminUser)).post(
      '/api/v1/channel-database/99/retroactive-decrypt',
    );
    expect(res.status).toBe(404);
  });

  it('returns 400 when channel is disabled', async () => {
    mockDb.channelDatabase.getByIdAsync.mockResolvedValue({ ...mockChannel, isEnabled: false });
    const res = await request(createApp(adminUser)).post(
      '/api/v1/channel-database/1/retroactive-decrypt',
    );
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/disabled channel/);
  });

  it('returns 409 when already running', async () => {
    const { retroactiveDecryptionService } = await import(
      '../../services/retroactiveDecryptionService.js'
    );
    (retroactiveDecryptionService.isRunning as any).mockReturnValue(true);
    const res = await request(createApp(adminUser)).post(
      '/api/v1/channel-database/1/retroactive-decrypt',
    );
    expect(res.status).toBe(409);
  });

  it('starts decryption and returns 200', async () => {
    const { retroactiveDecryptionService } = await import(
      '../../services/retroactiveDecryptionService.js'
    );
    (retroactiveDecryptionService.isRunning as any).mockReturnValue(false);
    const res = await request(createApp(adminUser)).post(
      '/api/v1/channel-database/1/retroactive-decrypt',
    );
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ─── GET /:id/permissions ────────────────────────────────────────────────────

describe('GET /api/v1/channel-database/:id/permissions', () => {
  it('returns 403 for non-admin', async () => {
    const res = await request(createApp(regularUser)).get(
      '/api/v1/channel-database/1/permissions',
    );
    expect(res.status).toBe(403);
  });

  it('returns 404 when channel not found', async () => {
    mockDb.channelDatabase.getByIdAsync.mockResolvedValue(null);
    const res = await request(createApp(adminUser)).get(
      '/api/v1/channel-database/99/permissions',
    );
    expect(res.status).toBe(404);
  });

  it('returns permissions for existing channel', async () => {
    mockDb.channelDatabase.getPermissionsForChannelAsync.mockResolvedValue([
      { userId: 10, canViewOnMap: true, canRead: true, grantedBy: 1, grantedAt: 1000000 },
    ]);
    const res = await request(createApp(adminUser)).get(
      '/api/v1/channel-database/1/permissions',
    );
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBe(1);
    expect(res.body.data[0].userId).toBe(10);
  });
});

// ─── PUT /:id/permissions/:userId ────────────────────────────────────────────

describe('PUT /api/v1/channel-database/:id/permissions/:userId', () => {
  it('returns 403 for non-admin', async () => {
    const res = await request(createApp(regularUser))
      .put('/api/v1/channel-database/1/permissions/10')
      .send({ canViewOnMap: true, canRead: true });
    expect(res.status).toBe(403);
  });

  it('returns 404 when channel not found', async () => {
    mockDb.channelDatabase.getByIdAsync.mockResolvedValue(null);
    const res = await request(createApp(adminUser))
      .put('/api/v1/channel-database/99/permissions/10')
      .send({ canViewOnMap: true, canRead: true });
    expect(res.status).toBe(404);
  });

  it('returns 404 when target user not found', async () => {
    mockDb.findUserByIdAsync.mockResolvedValue(null);
    const res = await request(createApp(adminUser))
      .put('/api/v1/channel-database/1/permissions/999')
      .send({ canViewOnMap: true, canRead: true });
    expect(res.status).toBe(404);
  });

  it('returns 400 when permission values are not booleans', async () => {
    const res = await request(createApp(adminUser))
      .put('/api/v1/channel-database/1/permissions/10')
      .send({ canViewOnMap: 'yes', canRead: true });
    expect(res.status).toBe(400);
  });

  it('sets permission and returns 200', async () => {
    const res = await request(createApp(adminUser))
      .put('/api/v1/channel-database/1/permissions/10')
      .send({ canViewOnMap: true, canRead: false });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockDb.channelDatabase.setPermissionAsync).toHaveBeenCalledOnce();
  });
});

// ─── DELETE /:id/permissions/:userId ─────────────────────────────────────────

describe('DELETE /api/v1/channel-database/:id/permissions/:userId', () => {
  it('returns 403 for non-admin', async () => {
    const res = await request(createApp(regularUser)).delete(
      '/api/v1/channel-database/1/permissions/10',
    );
    expect(res.status).toBe(403);
  });

  it('returns 404 when channel not found', async () => {
    mockDb.channelDatabase.getByIdAsync.mockResolvedValue(null);
    const res = await request(createApp(adminUser)).delete(
      '/api/v1/channel-database/99/permissions/10',
    );
    expect(res.status).toBe(404);
  });

  it('deletes permission and returns 200', async () => {
    const res = await request(createApp(adminUser)).delete(
      '/api/v1/channel-database/1/permissions/10',
    );
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockDb.channelDatabase.deletePermissionAsync).toHaveBeenCalledWith(10, 1);
  });
});
