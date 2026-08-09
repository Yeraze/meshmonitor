/**
 * GET /api/messages/first-unread (#4607)
 *
 * The unread-divider anchor endpoint. The query itself is covered against all
 * three backends in `src/db/repositories/notifications.test.ts`; what matters
 * here is that the route never hands a caller an anchor for a conversation
 * whose unread BADGE they are not allowed to see — the same gates
 * `/unread-counts` applies.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import databaseService from '../../services/database.js';

vi.mock('../utils/resolveSourceManager.js', () => ({
  resolveSourceManager: () => ({
    getLocalNodeInfo: () => ({ nodeId: '!me' }),
    getAllNodesAsync: async () => [
      { nodeNum: 1, user: { id: '!peer' } },
      { nodeNum: 2, user: { id: '!hidden' } },
    ],
  }),
}));

vi.mock('../utils/nodeEnhancer.js', () => ({
  // Only `!peer` is visible to the caller; `!hidden` is filtered by channel
  // permission, exactly as it would be for the unread counts.
  filterNodesByChannelPermission: async (nodes: any[]) => nodes.filter(n => n.user?.id === '!peer'),
}));

import messageRoutes from './messageRoutes.js';

const RAW = {
  channels: { 0: 1000, 5: 2000 },
  directMessages: { '!peer': 3000, '!hidden': 4000 },
};

function createApp(user: any) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.user = user; next(); });
  app.use('/api/messages', messageRoutes);
  return app;
}

describe('GET /api/messages/first-unread (#4607)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (databaseService as any).getFirstUnreadTimestampsAsync = vi.fn().mockResolvedValue(RAW);
    (databaseService as any).getUserPermissionSetAsync = vi.fn().mockResolvedValue({});
    (databaseService as any).checkPermissionAsync = vi.fn().mockResolvedValue(false);
    (databaseService as any).getChannelDatabaseEntriesAsync = vi.fn().mockResolvedValue([]);
    (databaseService as any).findUserByIdAsync = vi.fn();
  });

  it('403s a caller with neither channel nor message read permission', async () => {
    const res = await request(createApp({ id: 5, isAdmin: false })).get('/api/messages/first-unread');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('returns channel and DM anchors for an admin, in the ok() envelope', async () => {
    const res = await request(createApp({ id: 1, isAdmin: true })).get('/api/messages/first-unread');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.channels).toEqual({ 0: 1000, 5: 2000 });
    // `!hidden` is dropped by the node-visibility filter.
    expect(res.body.data.directMessages).toEqual({ '!peer': 3000 });
  });

  it('drops channels the caller cannot read', async () => {
    // channel_0 granted, channel_5 not.
    (databaseService as any).checkPermissionAsync = vi.fn(
      async (_uid: number, resource: string) => resource === 'channel_0' || resource === 'messages'
    );

    const res = await request(createApp({ id: 5, isAdmin: false })).get('/api/messages/first-unread');

    expect(res.status).toBe(200);
    expect(res.body.data.channels).toEqual({ 0: 1000 });
  });

  it('omits DM anchors entirely without messages:read', async () => {
    (databaseService as any).checkPermissionAsync = vi.fn(
      async (_uid: number, resource: string) => resource.startsWith('channel_')
    );

    const res = await request(createApp({ id: 5, isAdmin: false })).get('/api/messages/first-unread');

    expect(res.status).toBe(200);
    expect(res.body.data.directMessages).toEqual({});
  });

  it('forwards sourceId and excludeMqtt to the query', async () => {
    await request(createApp({ id: 1, isAdmin: true }))
      .get('/api/messages/first-unread?sourceId=src-a&excludeMqtt=true');

    expect((databaseService as any).getFirstUnreadTimestampsAsync)
      .toHaveBeenCalledWith(1, '!me', 'src-a', true);
  });

  it('reports 500 through the fail() envelope when the query throws', async () => {
    (databaseService as any).getFirstUnreadTimestampsAsync = vi.fn().mockRejectedValue(new Error('boom'));

    const res = await request(createApp({ id: 1, isAdmin: true })).get('/api/messages/first-unread');

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('FIRST_UNREAD_FAILED');
  });
});
