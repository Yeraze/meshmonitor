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

  it('POST /unsubscribe removes only the given source and returns remainingSources', async () => {
    await seedRow(harness.sourceA);
    await seedRow(harness.sourceB);
    const agent = await harness.loginAs(harness.limited);

    const res = await agent.post('/push/unsubscribe').send({ endpoint: ENDPOINT, sourceId: harness.sourceA });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, remainingSources: 1 });
    expect(await sourcesFor()).toEqual([harness.sourceB]);
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

  it('POST /subscription-status answers per source', async () => {
    await seedRow(harness.sourceA);
    const agent = await harness.loginAs(harness.limited);

    const onA = await agent.post('/push/subscription-status').send({ endpoint: ENDPOINT, sourceId: harness.sourceA });
    expect(onA.status).toBe(200);
    expect(onA.body).toEqual({ success: true, subscribed: true, otherSources: 0 });

    const onB = await agent.post('/push/subscription-status').send({ endpoint: ENDPOINT, sourceId: harness.sourceB });
    expect(onB.status).toBe(200);
    expect(onB.body).toEqual({ success: true, subscribed: false, otherSources: 1 });
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
