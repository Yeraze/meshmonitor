/**
 * messageRoutes — channel purge sourceId scoping tests
 *
 * DELETE /api/messages/channels/:channelId requires sourceId and checks
 * channel_<id>:write permission scoped to that source.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import databaseService from '../../services/database.js';
import messageRoutes from './messageRoutes.js';

const normalUser = { id: 5, username: 'u', isActive: true, isAdmin: false };

const createApp = () => {
  const app = express();
  app.use(express.json());
  app.use(session({
    secret: 'test-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
  }));
  app.use((req: any, _res, next) => {
    req.user = normalUser;
    next();
  });
  app.use('/api/messages', messageRoutes);
  return app;
};

const mockMessagesRepo: any = {
  purgeChannelMessages: vi.fn().mockResolvedValue(3),
  deleteMessage: vi.fn(),
  purgeDirectMessages: vi.fn(),
};

describe('DELETE /api/messages/channels/:channelId — sourceId scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (databaseService as any).getUserPermissionSetAsync = vi.fn().mockResolvedValue({});
    (databaseService as any).checkPermissionAsync = vi.fn();
    (databaseService as any).auditLogAsync = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(databaseService, 'messages', {
      get: () => mockMessagesRepo,
      configurable: true,
    });
  });

  it('returns 400 when sourceId is missing', async () => {
    const res = await request(createApp()).delete('/api/messages/channels/2');
    expect(res.status).toBe(400);
    expect(mockMessagesRepo.purgeChannelMessages).not.toHaveBeenCalled();
  });

  it('checks channel_N:write scoped to sourceId from query', async () => {
    (databaseService as any).checkPermissionAsync.mockResolvedValue(true);
    const res = await request(createApp()).delete('/api/messages/channels/2?sourceId=srcA');
    expect(res.status).toBe(200);
    expect((databaseService as any).checkPermissionAsync).toHaveBeenCalledWith(
      5, 'channel_2', 'write', 'srcA'
    );
  });

  it('returns 403 when channel_N:write denied for that sourceId', async () => {
    (databaseService as any).checkPermissionAsync.mockResolvedValue(false);
    const res = await request(createApp()).delete('/api/messages/channels/3?sourceId=srcB');
    expect(res.status).toBe(403);
    expect(mockMessagesRepo.purgeChannelMessages).not.toHaveBeenCalled();
  });

  it('grants on sourceA, denies on sourceB (per-source isolation)', async () => {
    (databaseService as any).checkPermissionAsync.mockImplementation(
      (_uid: number, _r: string, _a: string, sid?: string) => Promise.resolve(sid === 'sourceA')
    );
    const allowed = await request(createApp()).delete('/api/messages/channels/0?sourceId=sourceA');
    expect(allowed.status).toBe(200);
    const denied = await request(createApp()).delete('/api/messages/channels/0?sourceId=sourceB');
    expect(denied.status).toBe(403);
  });
});
