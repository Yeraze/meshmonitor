/**
 * GET /api/v1/sources/:sourceId/messages/search
 *
 * Shares the web search's scoping (#5517): per-source and per-channel in SQL,
 * dates in epoch ms, and MeshCore history read from `meshcore_messages`
 * whether or not the source is connected.
 *
 * Real harness + real API tokens: the permission SQL, the v1 token auth and
 * the repository query are all the real thing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRouteTestApp, type RouteTestHarness } from '../../test-helpers/routeTestApp.js';
import { CHANNEL_DB_OFFSET } from '../../constants/meshtastic.js';

// No managers registered: MeshCore search must not depend on a live manager.
vi.mock('../../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn(() => null),
    getAllManagers: vi.fn(() => []),
    getPrimaryMeshtasticSourceId: vi.fn(() => null),
    startManager: vi.fn(),
    stopManager: vi.fn(),
  },
}));

vi.mock('../../middleware/rateLimiters.js', () => ({
  messageLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  translateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import v1Router from './index.js';

const MC_SOURCE = 'rt-v1-search-mc';
const T0 = 1_760_000_000_000;
const PEER = { nodeNum: 0x0c000003, nodeId: '!0c000003' };

describe('GET /api/v1/sources/:sourceId/messages/search', () => {
  let harness: RouteTestHarness;
  let seq = 0;

  const seed = async (sourceId: string, channel: number, text: string, time = T0 + ++seq * 1000) => {
    await harness.db.messages.insertMessage(
      {
        id: `${sourceId}_${PEER.nodeNum}_${7000 + ++seq}`,
        fromNodeNum: PEER.nodeNum,
        toNodeNum: 0xffffffff,
        fromNodeId: PEER.nodeId,
        toNodeId: '!ffffffff',
        text,
        channel,
        portnum: 1,
        timestamp: time,
        rxTime: time,
        createdAt: time,
      } as never,
      sourceId,
    );
  };

  const seedMc = async (text: string, extra: Record<string, unknown> = {}) => {
    seq++;
    await harness.db.meshcore.insertMessage(
      {
        id: `v1mcs-${seq}`,
        fromPublicKey: 'channel-0',
        fromName: 'Bob',
        toPublicKey: null,
        text,
        timestamp: T0 + seq * 1000,
        messageType: 'text',
        sourceId: MC_SOURCE,
        createdAt: T0 + seq * 1000,
        ...extra,
      } as never,
      MC_SOURCE,
    );
  };

  const texts = (body: { data: Array<{ text: string }> }) => body.data.map((m) => m.text).sort();

  const search = async (user: RouteTestHarness['admin'], sourceId: string, qs: string) => {
    const token = await harness.tokenFor(user);
    return request(harness.app)
      .get(`/api/v1/sources/${sourceId}/messages/search?${qs}`)
      .set('Authorization', `Bearer ${token}`);
  };

  beforeEach(async () => {
    seq = 0;
    harness = await createRouteTestApp({
      mount: (app: express.Express) => app.use('/api/v1', v1Router),
      useOptionalAuth: false,
    });
    await harness.db.sources.deleteSource(MC_SOURCE).catch(() => {});
    await harness.db.sources.createSource({ id: MC_SOURCE, name: 'MC', type: 'meshcore', config: {}, enabled: true });
  });

  afterEach(async () => {
    await harness.db.messages.deleteAllMessages(harness.sourceA);
    await harness.db.messages.deleteAllMessages(harness.sourceB);
    await harness.db.meshcore.deleteAllMessagesForSource(MC_SOURCE);
    await harness.db.sources.deleteSource(MC_SOURCE).catch(() => {});
    await harness.cleanup();
  });

  describe('request validation and auth', () => {
    it('requires a token', async () => {
      const res = await request(harness.app).get(`/api/v1/sources/${harness.sourceA}/messages/search?q=hi`);
      expect(res.status).toBe(401);
    });

    it('rejects an invalid token', async () => {
      const res = await request(harness.app)
        .get(`/api/v1/sources/${harness.sourceA}/messages/search?q=hi`)
        .set('Authorization', 'Bearer mm_v1_not_a_real_token_000000000000');
      expect(res.status).toBe(401);
    });

    it.each(['', 'q=', 'q=%20%20'])('rejects a missing or blank q (%s)', async (qs) => {
      const res = await search(harness.admin, harness.sourceA, qs);
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it.each(['q=a', 'q=%20a%20'])('rejects a q shorter than 2 characters after trimming (%s)', async (qs) => {
      const res = await search(harness.admin, harness.sourceA, qs);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/at least 2 characters/);
    });

    it('accepts a 2-character q', async () => {
      const res = await search(harness.admin, harness.sourceA, 'q=hi');
      expect(res.status).toBe(200);
    });

    it('rejects an unknown scope', async () => {
      const res = await search(harness.admin, harness.sourceA, 'q=hello&scope=everything');
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/scope/);
    });

    it('refuses a source the token was not granted', async () => {
      await seed(harness.sourceB, 0, 'hello b');
      await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
      const res = await search(harness.limited, harness.sourceB, 'q=hello');
      expect(res.status).toBe(403);
    });
  });

  describe('Meshtastic sources', () => {
    it('returns matches with the documented envelope', async () => {
      await seed(harness.sourceA, 0, 'hello world');
      await seed(harness.sourceA, 0, 'hello back');
      const res = await search(harness.admin, harness.sourceA, 'q=hello');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, count: 2, total: 2 });
      expect(texts(res.body)).toEqual(['hello back', 'hello world']);
      expect(res.body.data.every((m: { source: string }) => m.source === 'standard')).toBe(true);
    });

    it('scopes to the path source, so other sources never appear', async () => {
      for (let i = 0; i < 3; i++) await seed(harness.sourceA, 0, `alpha ${i}`);
      for (let i = 0; i < 4; i++) await seed(harness.sourceB, 0, `alpha b${i}`);
      const res = await search(harness.admin, harness.sourceA, 'q=alpha&limit=2');
      expect(res.body.total).toBe(3);
      expect(res.body.count).toBe(2);
      expect(res.body.data.every((m: { sourceId: string }) => m.sourceId === harness.sourceA)).toBe(true);
    });

    it('treats startDate/endDate as milliseconds', async () => {
      await seed(harness.sourceA, 0, 'net check-in', T0);
      const hit = await search(harness.admin, harness.sourceA, `q=net&startDate=${T0 - 60_000}&endDate=${T0 + 60_000}`);
      expect(texts(hit.body)).toEqual(['net check-in']);
      const secs = await search(
        harness.admin,
        harness.sourceA,
        `q=net&startDate=${Math.floor((T0 - 60_000) / 1000)}&endDate=${Math.floor((T0 + 60_000) / 1000)}`,
      );
      expect(secs.body.total).toBe(0);
    });

    it('hides a channel the token lacks channel_N:read on', async () => {
      await seed(harness.sourceA, 0, 'hello ch0');
      await seed(harness.sourceA, 2, 'hello ch2');
      await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
      await harness.grant(harness.limited.id, 'channel_0', 'read', harness.sourceA);
      const res = await search(harness.limited, harness.sourceA, 'q=hello');
      expect(res.status).toBe(200);
      expect(texts(res.body)).toEqual(['hello ch0']);
      expect(res.body.total).toBe(1);

      // Asking for the hidden channel directly still returns nothing.
      const asked = await search(harness.limited, harness.sourceA, 'q=hello&channels=2');
      expect(asked.body.total).toBe(0);
    });

    it('honours the channels, fromNodeId, caseSensitive and scope filters', async () => {
      await seed(harness.sourceA, 0, 'Hello zero');
      await seed(harness.sourceA, 1, 'hello one');
      expect(texts((await search(harness.admin, harness.sourceA, 'q=hello&channels=1')).body)).toEqual(['hello one']);
      expect(texts((await search(harness.admin, harness.sourceA, 'q=Hello&caseSensitive=true')).body)).toEqual(['Hello zero']);
      expect((await search(harness.admin, harness.sourceA, 'q=hello')).body.total).toBe(2);
      expect((await search(harness.admin, harness.sourceA, 'q=hello&fromNodeId=!deadbeef')).body.total).toBe(0);
      expect((await search(harness.admin, harness.sourceA, `q=hello&fromNodeId=${encodeURIComponent(PEER.nodeId)}`)).body.total).toBe(2);
      expect((await search(harness.admin, harness.sourceA, 'q=hello&scope=dms')).body.total).toBe(0);
      expect((await search(harness.admin, harness.sourceA, 'q=hello&scope=meshcore')).body.total).toBe(0);
    });

    it('pages with limit and offset', async () => {
      await seed(harness.sourceA, 0, 'page one');
      await seed(harness.sourceA, 0, 'page two');
      await seed(harness.sourceA, 0, 'page three');
      const capped = await search(harness.admin, harness.sourceA, 'q=page&limit=500');
      expect(capped.body.count).toBe(3);
      const second = await search(harness.admin, harness.sourceA, 'q=page&limit=2&offset=2');
      expect(second.body.total).toBe(3);
      expect(second.body.count).toBe(1);
    });

    it('lets a non-admin search a virtual channel they can read', async () => {
      const vcId = await harness.db.channelDatabase.createAsync({
        name: `V1 Search VC ${Date.now()}`,
        psk: Buffer.alloc(16, 7).toString('base64'),
        pskLength: 16,
        isEnabled: true,
      });
      try {
        await seed(harness.sourceA, CHANNEL_DB_OFFSET + vcId, 'hello virtual');
        await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
        await harness.db.channelDatabase.setPermissionAsync({
          userId: harness.limited.id, channelDatabaseId: vcId, canRead: true, canViewOnMap: false,
        });
        expect(texts((await search(harness.limited, harness.sourceA, 'q=hello')).body)).toEqual(['hello virtual']);
      } finally {
        await harness.db.channelDatabase.deletePermissionAsync(harness.limited.id, vcId).catch(() => {});
        await harness.db.channelDatabase.deleteAsync(vcId).catch(() => {});
      }
    });
  });

  describe('MeshCore sources', () => {
    it('finds stored history with no manager connected', async () => {
      await seedMc('meshcore hello');
      await seedMc('meshcore dm hello', { fromPublicKey: 'bb'.repeat(32), fromName: null, toPublicKey: 'aa'.repeat(32) });
      const res = await search(harness.admin, MC_SOURCE, 'q=hello');
      expect(res.status).toBe(200);
      expect(texts(res.body)).toEqual(['meshcore dm hello', 'meshcore hello']);
      expect(res.body.total).toBe(2);
      expect(res.body.data.every((m: { source: string }) => m.source === 'meshcore')).toBe(true);
    });

    it('finds stored history for a non-admin token with messages:read', async () => {
      await seedMc('meshcore hello');
      await harness.grant(harness.limited.id, 'messages', 'read', MC_SOURCE);
      const res = await search(harness.limited, MC_SOURCE, 'q=hello');
      expect(texts(res.body)).toEqual(['meshcore hello']);
      // The channels filter narrows MeshCore results too.
      expect((await search(harness.limited, MC_SOURCE, 'q=hello&channels=1')).body.total).toBe(0);
    });

    it('refuses an ungranted MeshCore source', async () => {
      await seedMc('meshcore hello');
      await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
      const res = await search(harness.limited, MC_SOURCE, 'q=hello');
      expect(res.status).toBe(403);
    });

    it('excludes MeshCore rows from a source the path does not name', async () => {
      await seedMc('meshcore hello');
      await seed(harness.sourceA, 0, 'mesh hello');
      const res = await search(harness.admin, harness.sourceA, 'q=hello');
      expect(texts(res.body)).toEqual(['mesh hello']);
    });
  });
});
