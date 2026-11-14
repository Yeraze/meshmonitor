/**
 * Web Push per-source subscription routes (#5493).
 *
 * One browser has one push endpoint per origin, shared by every source it
 * subscribed on. These tests run the real session + optionalAuth +
 * requirePermission chain and the real pushNotificationService against the
 * harness DB, and assert that:
 *  - /unsubscribe drops only the given source's row and reports the rest,
 *  - /subscription-status answers per source,
 *  - /unsubscribe-all drops the endpoint from every source,
 *  - a user cannot probe or unsubscribe a source they cannot read.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { pushRouter } from './notificationRoutes.js';

// Non-DB mocks: the router module imports these, and they must not open
// real node connections in tests.
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn().mockReturnValue(null),
    getAllManagers: vi.fn().mockReturnValue([]),
  },
}));

vi.mock('../meshtasticManager.js', () => ({
  fallbackManager: { getLocalNodeInfo: vi.fn().mockReturnValue(null) },
}));

const ENDPOINT = 'https://push.example.com/send/browser-5493';
const MESH = '__mesh__';

describe('pushRouter — per-source subscriptions (#5493)', () => {
  let harness: RouteTestHarness;

  const seedRow = async (sourceId: string, endpoint = ENDPOINT) => {
    await harness.db.notificationsRepo!.saveSubscription({
      userId: harness.limited.id,
      sourceId,
      endpoint,
      p256dhKey: 'p256dh',
      authKey: 'auth',
    });
  };

  const sourcesFor = (endpoint = ENDPOINT) =>
    harness.db.notificationsRepo!.getSubscriptionSourceIds(endpoint);

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: app => app.use('/push', pushRouter) });
    await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceB);
  });

  afterEach(async () => {
    await harness.db.notificationsRepo!.removeSubscription(ENDPOINT);
    await harness.db.notificationsRepo!.removeSubscription(`${ENDPOINT}-other`);
    await harness.cleanup();
  });

  // #5729: one subscription per browser for the whole mesh. Which sources
  // notify is the user's Web Push source list, not a row per source.
  it('POST /subscribe stores ONE mesh-wide row per browser, whichever source it came from', async () => {
    const agent = await harness.loginAs(harness.limited);
    const subscription = { endpoint: ENDPOINT, keys: { p256dh: 'p256dh', auth: 'auth' } };

    await agent.post('/push/subscribe').send({ subscription, sourceId: harness.sourceA }).expect(200);
    await agent.post('/push/subscribe').send({ subscription, sourceId: harness.sourceB }).expect(200);

    const rows = await harness.db.notificationsRepo!.getSubscriptionsByEndpoint(ENDPOINT);
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceId).toBe(MESH);
    expect(rows[0].userId).toBe(harness.limited.id);
  });

  it('POST /subscribe adds the source to a narrowed Web Push source list', async () => {
    await harness.db.notifications.setPushSourceIds(harness.limited.id, [harness.sourceA]);
    const agent = await harness.loginAs(harness.limited);

    await agent.post('/push/subscribe')
      .send({ subscription: { endpoint: ENDPOINT, keys: { p256dh: 'p256dh', auth: 'auth' } }, sourceId: harness.sourceB })
      .expect(200);

    const mesh = await harness.db.notifications.getMeshPreferences(harness.limited.id);
    expect(mesh?.pushSourceIds).toEqual([harness.sourceA, harness.sourceB].sort());
    expect(mesh?.saved).toBe(false);
  });

  it('POST /subscribe is refused on a source the user cannot read, and stores nothing', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post('/push/subscribe')
      .send({ subscription: { endpoint: ENDPOINT, keys: { p256dh: 'p256dh', auth: 'auth' } }, sourceId: 'rt-not-granted' });
    expect(res.status).toBe(403);
    expect(await sourcesFor()).toEqual([]);
  });

  it('POST /unsubscribe stops Web Push on this browser for the whole mesh', async () => {
    await seedRow(MESH);
    const agent = await harness.loginAs(harness.limited);

    const res = await agent.post('/push/unsubscribe').send({ endpoint: ENDPOINT, sourceId: harness.sourceA });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, remainingSources: 0 });
    expect(await sourcesFor()).toEqual([]);
  });

  it('POST /unsubscribe reports remainingSources 0 once the last source goes', async () => {
    await seedRow(harness.sourceA);
    const agent = await harness.loginAs(harness.limited);

    const res = await agent.post('/push/unsubscribe').send({ endpoint: ENDPOINT, sourceId: harness.sourceA });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, remainingSources: 0 });
    expect(await sourcesFor()).toEqual([]);
  });

  it('POST /unsubscribe rejects a missing endpoint', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post('/push/unsubscribe').send({ sourceId: harness.sourceA });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_ENDPOINT');
  });

  it('POST /subscription-status: one subscription covers every source', async () => {
    await seedRow(MESH);
    const agent = await harness.loginAs(harness.limited);

    const onA = await agent.post('/push/subscription-status').send({ endpoint: ENDPOINT, sourceId: harness.sourceA });
    expect(onA.status).toBe(200);
    expect(onA.body).toEqual({ success: true, subscribed: true, otherSources: 0 });

    const onB = await agent.post('/push/subscription-status').send({ endpoint: ENDPOINT, sourceId: harness.sourceB });
    expect(onB.status).toBe(200);
    expect(onB.body).toEqual({ success: true, subscribed: true, otherSources: 0 });
  });

  it('POST /unsubscribe-all removes the endpoint from every source and leaves other endpoints', async () => {
    await seedRow(harness.sourceA);
    await seedRow(harness.sourceB);
    await seedRow(harness.sourceA, `${ENDPOINT}-other`);
    const agent = await harness.loginAs(harness.limited);

    const res = await agent.post('/push/unsubscribe-all').send({ endpoint: ENDPOINT });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, removed: 2 });
    expect(await sourcesFor()).toEqual([]);
    expect(await sourcesFor(`${ENDPOINT}-other`)).toEqual([harness.sourceA]);
  });

  it('POST /unsubscribe-all rejects a missing endpoint', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post('/push/unsubscribe-all').send({});
    expect(res.status).toBe(400);
  });

  describe('POST /renew (#5863)', () => {
    const NEW = `${ENDPOINT}-renewed`;
    const newSubscription = { endpoint: NEW, keys: { p256dh: 'new-p256dh', auth: 'new-auth' } };

    afterEach(async () => {
      await harness.db.notificationsRepo!.removeSubscription(NEW);
    });

    it('moves every source the old endpoint held to the new endpoint', async () => {
      await seedRow(harness.sourceA);
      await seedRow(harness.sourceB);
      const agent = await harness.loginAs(harness.limited);

      const res = await agent.post('/push/renew').send({ oldEndpoint: ENDPOINT, subscription: newSubscription });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, renewed: 2, skipped: 0 });
      expect(await sourcesFor()).toEqual([]);
      expect((await sourcesFor(NEW)).sort()).toEqual([harness.sourceA, harness.sourceB].sort());

      const rows = await harness.db.notificationsRepo!.getSubscriptionsByEndpoint(NEW);
      expect(rows.every(r => r.userId === harness.limited.id && r.p256dhKey === 'new-p256dh' && r.authKey === 'new-auth')).toBe(true);
    });

    it("will not move another user's rows to the caller's endpoint", async () => {
      await seedRow(harness.sourceA);
      const agent = await harness.loginAs(harness.admin);

      const res = await agent.post('/push/renew').send({ oldEndpoint: ENDPOINT, subscription: newSubscription });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, renewed: 0, skipped: 1 });
      expect(await sourcesFor()).toEqual([harness.sourceA]);
      expect(await sourcesFor(NEW)).toEqual([]);
    });

    it('answers 200 with nothing renewed for an endpoint it has never seen', async () => {
      const agent = await harness.loginAs(harness.limited);

      const res = await agent.post('/push/renew').send({ oldEndpoint: `${ENDPOINT}-unknown`, subscription: newSubscription });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, renewed: 0, skipped: 0 });
      expect(await sourcesFor(NEW)).toEqual([]);
    });

    it('rejects a missing old endpoint or a malformed subscription', async () => {
      const agent = await harness.loginAs(harness.limited);

      const noOld = await agent.post('/push/renew').send({ subscription: newSubscription });
      expect(noOld.status).toBe(400);
      expect(noOld.body.code).toBe('MISSING_ENDPOINT');

      const noKeys = await agent.post('/push/renew').send({ oldEndpoint: ENDPOINT, subscription: { endpoint: NEW } });
      expect(noKeys.status).toBe(400);
      expect(noKeys.body.code).toBe('INVALID_SUBSCRIPTION');
    });
  });

  it('denies status and unsubscribe on a source the user cannot read', async () => {
    await harness.revokeAll(harness.limited.id);
    await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
    await seedRow(harness.sourceB);
    const agent = await harness.loginAs(harness.limited);

    const status = await agent.post('/push/subscription-status').send({ endpoint: ENDPOINT, sourceId: harness.sourceB });
    expect(status.status).toBe(403);

    const unsub = await agent.post('/push/unsubscribe').send({ endpoint: ENDPOINT, sourceId: harness.sourceB });
    expect(unsub.status).toBe(403);
    expect(await sourcesFor()).toEqual([harness.sourceB]);
  });
});
