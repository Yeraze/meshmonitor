/**
 * Message Search API Tests
 *
 * Tests the GET /api/v1/messages/search endpoint
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

const VALID_TEST_TOKEN = 'mm_v1_test_token_12345678901234567890';
const TEST_USER_ID = 1;

const testUser = {
  id: TEST_USER_ID,
  username: 'test-api-user',
  isActive: true,
  isAdmin: true,
  passwordHash: 'hash',
  salt: 'salt',
  createdAt: Date.now()
};

const searchResults = [
  {
    id: 'msg-1', fromNodeId: '!abcd0001', fromNodeNum: 2882400001,
    toNodeId: '!abcd0002', toNodeNum: 2882400002,
    text: 'hello world', channel: 0, timestamp: 1709000000,
    rxTime: 1709000001, createdAt: 1709000001
  },
  {
    id: 'msg-2', fromNodeId: '!abcd0002', fromNodeNum: 2882400002,
    toNodeId: '!abcd0001', toNodeNum: 2882400001,
    text: 'hello back', channel: 0, timestamp: 1709000100,
    rxTime: 1709000101, createdAt: 1709000101
  }
];

vi.mock('../../../services/database.js', () => ({
  default: {
    db: null,
    apiTokenModel: {
      validate: vi.fn(async (token: string) => token === VALID_TEST_TOKEN ? TEST_USER_ID : null),
      updateLastUsed: vi.fn()
    },
    userModel: {
      findById: vi.fn((id: number) => id === TEST_USER_ID ? testUser : null)
    },
    permissionModel: {
      check: vi.fn(() => true)
    },
    // Async methods required by authMiddleware
    validateApiTokenAsync: vi.fn(async (token: string) => {
      if (token === VALID_TEST_TOKEN) {
        return testUser;
      }
      return null;
    }),
    findUserByIdAsync: vi.fn(async (id: number) => {
      if (id === TEST_USER_ID) return testUser;
      return null;
    }),
    findUserByUsernameAsync: vi.fn().mockResolvedValue(null),
    checkPermissionAsync: vi.fn().mockResolvedValue(true),
    updateApiTokenLastUsedAsync: vi.fn(async () => {}),
    getUserPermissionSetAsync: vi.fn(async () => ({
      nodes: { read: true, write: false },
      messages: { read: true, write: true },
      channel_0: { viewOnMap: true, read: true, write: true },
      channel_1: { viewOnMap: true, read: true, write: true },
      channel_2: { viewOnMap: true, read: true, write: true },
      channel_3: { viewOnMap: true, read: true, write: true },
      channel_4: { viewOnMap: true, read: true, write: true },
      channel_5: { viewOnMap: true, read: true, write: true },
      channel_6: { viewOnMap: true, read: true, write: true },
      channel_7: { viewOnMap: true, read: true, write: true }
    })),
    auditLog: vi.fn(),
    auditLogAsync: vi.fn(async () => {}),
    getSetting: vi.fn((key: string) => {
      if (key === 'localNodeNum') return '2715451348';
      return null;
    }),
    // Messages methods
    searchMessagesAsync: vi.fn().mockResolvedValue({ messages: searchResults, total: 2 }),
    getMessagesByChannel: vi.fn().mockReturnValue([]),
    getMessages: vi.fn().mockReturnValue([]),
    getMessagesAfterTimestamp: vi.fn().mockReturnValue([]),
    drizzleDbType: 'sqlite'
  }
}));

vi.mock('../../meshtasticManager.js', () => ({
  default: { sendMessage: vi.fn(), getConnectionStatus: vi.fn().mockReturnValue('connected') }
}));

vi.mock('../../meshcoreManager.js', () => ({
  default: { getRecentMessages: vi.fn().mockReturnValue([]), isConnected: vi.fn().mockReturnValue(false) }
}));

vi.mock('../../middleware/rateLimiters.js', () => ({
  messageLimiter: (_req: any, _res: any, next: any) => next()
}));

vi.mock('../../messageQueueService.js', () => ({
  messageQueueService: { queueMessage: vi.fn(), enqueue: vi.fn() }
}));

const { default: databaseService } = await import('../../../services/database.js');

describe('GET /api/v1/messages/search', () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Re-set mock implementations since clearAllMocks resets them
    (databaseService.searchMessagesAsync as any).mockResolvedValue({ messages: searchResults, total: 2 });
    (databaseService as any).validateApiTokenAsync.mockImplementation(async (token: string) => {
      if (token === VALID_TEST_TOKEN) return testUser;
      return null;
    });
    (databaseService.findUserByIdAsync as any).mockImplementation(async (id: number) => {
      if (id === TEST_USER_ID) return testUser;
      return null;
    });
    (databaseService.getUserPermissionSetAsync as any).mockResolvedValue({
      nodes: { read: true, write: false },
      messages: { read: true, write: true },
      channel_0: { viewOnMap: true, read: true, write: true },
      channel_1: { viewOnMap: true, read: true, write: true },
      channel_2: { viewOnMap: true, read: true, write: true },
      channel_3: { viewOnMap: true, read: true, write: true },
      channel_4: { viewOnMap: true, read: true, write: true },
      channel_5: { viewOnMap: true, read: true, write: true },
      channel_6: { viewOnMap: true, read: true, write: true },
      channel_7: { viewOnMap: true, read: true, write: true }
    });

    app = express();
    const { default: v1Router } = await import('./index.js');
    app.use('/api/v1', v1Router);
  });

  it('should require q parameter', async () => {
    const res = await request(app)
      .get('/api/v1/messages/search')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('should reject empty q parameter', async () => {
    const res = await request(app)
      .get('/api/v1/messages/search?q=')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('should reject whitespace-only q parameter', async () => {
    const res = await request(app)
      .get('/api/v1/messages/search?q=%20%20')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('should return search results', async () => {
    const res = await request(app)
      .get('/api/v1/messages/search?q=hello')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.total).toBe(2);
    expect(res.body.count).toBe(2);
  });

  it('should add source field to results', async () => {
    const res = await request(app)
      .get('/api/v1/messages/search?q=hello')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.data[0].source).toBe('standard');
    expect(res.body.data[1].source).toBe('standard');
  });

  it('should pass caseSensitive option', async () => {
    await request(app)
      .get('/api/v1/messages/search?q=hello&caseSensitive=true')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`);
    expect(databaseService.searchMessagesAsync).toHaveBeenCalledWith(
      expect.objectContaining({ caseSensitive: true })
    );
  });

  it('should default caseSensitive to false', async () => {
    await request(app)
      .get('/api/v1/messages/search?q=hello')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`);
    expect(databaseService.searchMessagesAsync).toHaveBeenCalledWith(
      expect.objectContaining({ caseSensitive: false })
    );
  });

  it('should pass scope filter', async () => {
    await request(app)
      .get('/api/v1/messages/search?q=hello&scope=channels')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`);
    expect(databaseService.searchMessagesAsync).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'channels' })
    );
  });

  it('should pass date range filters', async () => {
    await request(app)
      .get('/api/v1/messages/search?q=hello&startDate=1709000000&endDate=1709100000')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`);
    expect(databaseService.searchMessagesAsync).toHaveBeenCalledWith(
      expect.objectContaining({ startDate: 1709000000, endDate: 1709100000 })
    );
  });

  it('should pass channel filter', async () => {
    await request(app)
      .get('/api/v1/messages/search?q=hello&channels=0,1')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`);
    expect(databaseService.searchMessagesAsync).toHaveBeenCalledWith(
      expect.objectContaining({ channels: expect.arrayContaining([0, 1]) })
    );
  });

  it('should pass fromNodeId filter', async () => {
    await request(app)
      .get('/api/v1/messages/search?q=hello&fromNodeId=!abcd0001')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`);
    expect(databaseService.searchMessagesAsync).toHaveBeenCalledWith(
      expect.objectContaining({ fromNodeId: '!abcd0001' })
    );
  });

  it('should respect limit parameter with max of 100', async () => {
    await request(app)
      .get('/api/v1/messages/search?q=hello&limit=200')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`);
    expect(databaseService.searchMessagesAsync).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 })
    );
  });

  it('should pass offset parameter', async () => {
    await request(app)
      .get('/api/v1/messages/search?q=hello&offset=10')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`);
    expect(databaseService.searchMessagesAsync).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 10 })
    );
  });

  it('should not search standard messages when scope is meshcore', async () => {
    await request(app)
      .get('/api/v1/messages/search?q=hello&scope=meshcore')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`);
    expect(databaseService.searchMessagesAsync).not.toHaveBeenCalled();
  });

  it('should require authentication', async () => {
    const res = await request(app)
      .get('/api/v1/messages/search?q=hello');
    expect(res.status).toBe(401);
  });

  it('should reject invalid token', async () => {
    const res = await request(app)
      .get('/api/v1/messages/search?q=hello')
      .set('Authorization', 'Bearer invalid_token_value_here_12345');
    expect(res.status).toBe(401);
  });
});
