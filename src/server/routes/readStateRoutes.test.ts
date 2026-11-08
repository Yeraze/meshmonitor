/**
 * Conversation read-state routes (#4607) — permission + behaviour tests.
 *
 * Uses the real-middleware harness so `messages:read` is enforced by actual
 * SQL, not a hand-rolled lambda. The property that matters most here is
 * per-user isolation: the whole reason this table replaced localStorage is
 * that two operators must not share one set of read markers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import readStateRoutes from './readStateRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

describe('readStateRoutes (#4607)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/', readStateRoutes),
    });
    await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
    // Deliberately no grant on sourceB.
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  describe('GET /', () => {
    it('400s without a sourceId', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SOURCE_ID_REQUIRED');
    });

    it('returns an empty map for a source with no markers', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/?sourceId=${harness.sourceA}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual({ meshcore_channel: {}, meshcore_dm: {}, meshcore_room: {} });
    });

    it('403s on a source the user has no messages:read grant for', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/?sourceId=${harness.sourceB}`);
      expect(res.status).toBe(403);
    });
  });

  describe('POST /', () => {
    it('rejects an unknown conversation kind', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/').send({
        sourceId: harness.sourceA,
        kind: 'meshtastic_channel',
        conversationKey: '0',
        lastReadAt: 1000,
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_CONVERSATION_KIND');
    });

    it('rejects a missing conversationKey and a non-numeric lastReadAt', async () => {
      const agent = await harness.loginAs(harness.admin);

      const noKey = await agent.post('/').send({
        sourceId: harness.sourceA, kind: 'meshcore_dm', conversationKey: '', lastReadAt: 1,
      });
      expect(noKey.status).toBe(400);
      expect(noKey.body.code).toBe('CONVERSATION_KEY_REQUIRED');

      const badTs = await agent.post('/').send({
        sourceId: harness.sourceA, kind: 'meshcore_dm', conversationKey: 'peer', lastReadAt: 'soon',
      });
      expect(badTs.status).toBe(400);
      expect(badTs.body.code).toBe('INVALID_LAST_READ_AT');
    });

    it('403s on a source the user has no messages:read grant for', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/').send({
        sourceId: harness.sourceB, kind: 'meshcore_channel', conversationKey: '0', lastReadAt: 1000,
      });
      expect(res.status).toBe(403);
    });

    it('persists a marker and reads it back', async () => {
      const agent = await harness.loginAs(harness.limited);

      const write = await agent.post('/').send({
        sourceId: harness.sourceA, kind: 'meshcore_channel', conversationKey: '2', lastReadAt: 4242,
      });
      expect(write.status).toBe(200);
      expect(write.body.data).toEqual({ lastReadAt: 4242 });

      const read = await agent.get(`/?sourceId=${harness.sourceA}`);
      expect(read.body.data.meshcore_channel['2']).toBe(4242);
    });

    it('never rewinds a marker, and reports the effective value', async () => {
      const agent = await harness.loginAs(harness.limited);

      await agent.post('/').send({
        sourceId: harness.sourceA, kind: 'meshcore_dm', conversationKey: 'peerA', lastReadAt: 9000,
      });
      const stale = await agent.post('/').send({
        sourceId: harness.sourceA, kind: 'meshcore_dm', conversationKey: 'peerA', lastReadAt: 100,
      });

      expect(stale.status).toBe(200);
      expect(stale.body.data).toEqual({ lastReadAt: 9000 });
    });

    it('keeps two users\' markers apart on the same source and conversation', async () => {
      // The multi-user defect the localStorage store could not express.
      const limitedAgent = await harness.loginAs(harness.limited);
      const adminAgent = await harness.loginAs(harness.admin);

      await limitedAgent.post('/').send({
        sourceId: harness.sourceA, kind: 'meshcore_channel', conversationKey: '0', lastReadAt: 1000,
      });
      await adminAgent.post('/').send({
        sourceId: harness.sourceA, kind: 'meshcore_channel', conversationKey: '0', lastReadAt: 8000,
      });

      const limitedRead = await limitedAgent.get(`/?sourceId=${harness.sourceA}`);
      const adminRead = await adminAgent.get(`/?sourceId=${harness.sourceA}`);

      expect(limitedRead.body.data.meshcore_channel['0']).toBe(1000);
      expect(adminRead.body.data.meshcore_channel['0']).toBe(8000);
    });

    it('keeps one user\'s markers apart across sources', async () => {
      const agent = await harness.loginAs(harness.admin);

      await agent.post('/').send({
        sourceId: harness.sourceA, kind: 'meshcore_channel', conversationKey: '0', lastReadAt: 1000,
      });
      await agent.post('/').send({
        sourceId: harness.sourceB, kind: 'meshcore_channel', conversationKey: '0', lastReadAt: 8000,
      });

      const a = await agent.get(`/?sourceId=${harness.sourceA}`);
      const b = await agent.get(`/?sourceId=${harness.sourceB}`);
      expect(a.body.data.meshcore_channel['0']).toBe(1000);
      expect(b.body.data.meshcore_channel['0']).toBe(8000);
    });
  });

  describe('POST /batch (#6261)', () => {
    const entry = (over: Record<string, unknown> = {}) => ({
      kind: 'meshcore_room', conversationKey: 'roomA', lastReadAt: 5000, ...over,
    });

    it('writes every entry and returns the effective state', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/batch').send({
        sourceId: harness.sourceA,
        entries: [entry(), entry({ kind: 'meshcore_dm', conversationKey: 'peerA', lastReadAt: 100 }), entry({ kind: 'meshcore_channel', conversationKey: '2' })],
      });
      expect(res.status).toBe(200);
      expect(res.body.data.state).toEqual({
        meshcore_channel: { '2': 5000 },
        meshcore_dm: { peerA: 100 },
        meshcore_room: { roomA: 5000 },
      });
      const read = await agent.get(`/?sourceId=${harness.sourceA}`);
      expect(read.body.data.meshcore_room.roomA).toBe(5000);
    });

    it('never rewinds a marker', async () => {
      const agent = await harness.loginAs(harness.limited);
      await agent.post('/batch').send({ sourceId: harness.sourceA, entries: [entry({ lastReadAt: 9000 })] });
      const res = await agent.post('/batch').send({ sourceId: harness.sourceA, entries: [entry({ lastReadAt: 10 })] });
      expect(res.body.data.state.meshcore_room.roomA).toBe(9000);
    });

    it('403s on a source without a grant', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/batch').send({ sourceId: harness.sourceB, entries: [entry()] });
      expect(res.status).toBe(403);
    });

    it('400s on a missing sourceId', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/batch').send({ entries: [entry()] });
      expect(res.status).toBe(400);
    });

    it('400s on bad kind, missing key, bad timestamp, and empty entries', async () => {
      const agent = await harness.loginAs(harness.admin);
      const post = (entries: unknown) => agent.post('/batch').send({ sourceId: harness.sourceA, entries });
      expect((await post([entry({ kind: 'meshtastic_channel' })])).body.code).toBe('INVALID_CONVERSATION_KIND');
      expect((await post([entry({ conversationKey: '' })])).body.code).toBe('CONVERSATION_KEY_REQUIRED');
      expect((await post([entry({ lastReadAt: 'soon' })])).body.code).toBe('INVALID_LAST_READ_AT');
      // Prototype names and odd characters are refused (CodeQL property injection).
      expect((await post([entry({ conversationKey: '__proto__' })])).body.code).toBe('INVALID_CONVERSATION_KEY');
      expect((await post([entry({ conversationKey: 'constructor' })])).body.code).toBe('INVALID_CONVERSATION_KEY');
      expect((await post([entry({ conversationKey: 'a b' })])).body.code).toBe('INVALID_CONVERSATION_KEY');
      expect((await post([])).status).toBe(400);
      expect((await post('nope')).status).toBe(400);
    });

    it('400s TOO_MANY_ENTRIES above 500', async () => {
      const agent = await harness.loginAs(harness.admin);
      const entries = Array.from({ length: 501 }, (_, i) => entry({ conversationKey: `r${i}` }));
      const res = await agent.post('/batch').send({ sourceId: harness.sourceA, entries });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('TOO_MANY_ENTRIES');
    });

    it('a batch on source A is not visible on source B', async () => {
      const agent = await harness.loginAs(harness.admin);
      await agent.post('/batch').send({ sourceId: harness.sourceA, entries: [entry()] });
      const b = await agent.get(`/?sourceId=${harness.sourceB}`);
      expect(b.body.data.meshcore_room).toEqual({});
    });

    it('lets an anonymous user with messages:read write', async () => {
      await harness.grant(harness.anonymous.id, 'messages', 'read', harness.sourceA);
      const res = await (await harness.loginAs(null)).post('/batch').send({ sourceId: harness.sourceA, entries: [entry()] });
      expect(res.status).toBe(200);
    });
  });
});
