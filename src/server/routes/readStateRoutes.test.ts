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
      expect(res.body.data).toEqual({ meshcore_channel: {}, meshcore_dm: {} });
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
});
