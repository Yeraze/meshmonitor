/**
 * v1 messages — sourceId permission scoping tests
 *
 * Verifies that GET /api/v1/messages?sourceId=A enforces per-source permission
 * via checkPermissionAsync(... sourceId), and GET without sourceId falls back
 * to getUserPermissionSetAsync (global behavior).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { Express } from 'express';
import request from 'supertest';

vi.mock('../../../services/database.js', () => ({
  default: {
    checkPermissionAsync: vi.fn(),
    getUserPermissionSetAsync: vi.fn(),
    messages: {
      getMessages: vi.fn().mockResolvedValue([]),
      getMessagesByChannel: vi.fn().mockResolvedValue([]),
      getMessagesAfterTimestamp: vi.fn().mockResolvedValue([]),
    },
  }
}));

vi.mock('../../meshtasticManager.js', () => ({ default: {} }));
vi.mock('../../meshcoreManager.js', () => ({ default: {} }));
vi.mock('../../sourceManagerRegistry.js', () => ({ sourceManagerRegistry: { getManager: vi.fn() } }));
vi.mock('../../messageQueueService.js', () => ({ messageQueueService: {} }));
vi.mock('../../middleware/rateLimiters.js', () => ({
  messageLimiter: (_req: any, _res: any, next: any) => next(),
}));

import databaseService from '../../../services/database.js';
import v1Messages from './messages.js';

const mockDb = databaseService as any;

const normalUser = { id: 99, username: 'u', isActive: true, isAdmin: false };

const buildApp = (): Express => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = normalUser;
    next();
  });
  app.use('/v1/messages', v1Messages);
  return app;
};

describe('v1 messages — sourceId scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.checkPermissionAsync.mockResolvedValue(true);
    mockDb.getUserPermissionSetAsync.mockResolvedValue({
      messages: { read: true, write: false },
      channel_0: { read: true },
    });
  });

  it('GET ?sourceId=A → checkPermissionAsync called with sourceId=A, no global lookup', async () => {
    const res = await request(buildApp()).get('/v1/messages').query({ sourceId: 'A' });
    expect(res.status).toBe(200);
    // All checkPermissionAsync calls must include sourceId='A'
    const calls = mockDb.checkPermissionAsync.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call[3]).toBe('A');
    }
    expect(mockDb.getUserPermissionSetAsync).not.toHaveBeenCalled();
  });

  it('GET without sourceId → uses global getUserPermissionSetAsync, no per-source checks', async () => {
    const res = await request(buildApp()).get('/v1/messages');
    expect(res.status).toBe(200);
    expect(mockDb.getUserPermissionSetAsync).toHaveBeenCalledWith(99);
    expect(mockDb.checkPermissionAsync).not.toHaveBeenCalled();
  });

  it('GET ?sourceId=B with no per-source grant → empty accessible channels (no leaked messages)', async () => {
    // Per-source: deny everything
    mockDb.checkPermissionAsync.mockResolvedValue(false);
    mockDb.messages.getMessages.mockResolvedValue([
      { id: 'm1', channel: 0, sourceId: 'B' },
      { id: 'm2', channel: 1, sourceId: 'B' },
    ]);
    const res = await request(buildApp()).get('/v1/messages').query({ sourceId: 'B' });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
  });
});
