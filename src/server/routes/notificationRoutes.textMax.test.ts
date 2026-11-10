/**
 * Message text length on POST/GET /push/preferences (#6278).
 *
 * Real session + requireAuth + requirePermission chain and the real
 * notifications repository against the harness DB.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { pushRouter } from './notificationRoutes.js';

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn().mockReturnValue(null),
    getAllManagers: vi.fn().mockReturnValue([]),
  },
}));

vi.mock('../meshtasticManager.js', () => ({
  fallbackManager: { getLocalNodeInfo: vi.fn().mockReturnValue(null) },
}));

describe('/push/preferences — message text length', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: app => app.use('/push', pushRouter) });
    await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceB);
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('GET answers null for a user who has saved none', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/push/preferences?sourceId=${harness.sourceA}`);
    expect(res.status).toBe(200);
    expect(res.body.messageTextMaxPush).toBeNull();
    expect(res.body.messageTextMaxApprise).toBeNull();
  });

  it('saves both values and reads them back', async () => {
    const agent = await harness.loginAs(harness.limited);
    await agent
      .post('/push/preferences')
      .send({ sourceId: harness.sourceA, messageTextMaxPush: 250, messageTextMaxApprise: 1000 })
      .expect(200);
    const read = await agent.get(`/push/preferences?sourceId=${harness.sourceA}`);
    expect(read.body).toMatchObject({ messageTextMaxPush: 250, messageTextMaxApprise: 1000 });
  });

  it('a value saved for source A does not reach source B', async () => {
    const agent = await harness.loginAs(harness.limited);
    await agent
      .post('/push/preferences')
      .send({ sourceId: harness.sourceA, messageTextMaxApprise: 500 })
      .expect(200);
    const b = await agent.get(`/push/preferences?sourceId=${harness.sourceB}`);
    expect(b.body.messageTextMaxApprise).toBeNull();
    expect(b.body.messageTextMaxPush).toBeNull();
  });

  it('null and a blank string clear the value', async () => {
    const agent = await harness.loginAs(harness.limited);
    await agent
      .post('/push/preferences')
      .send({ sourceId: harness.sourceA, messageTextMaxPush: 250, messageTextMaxApprise: 300 })
      .expect(200);
    await agent
      .post('/push/preferences')
      .send({ sourceId: harness.sourceA, messageTextMaxPush: null, messageTextMaxApprise: '  ' })
      .expect(200);
    const read = await agent.get(`/push/preferences?sourceId=${harness.sourceA}`);
    expect(read.body.messageTextMaxPush).toBeNull();
    expect(read.body.messageTextMaxApprise).toBeNull();
  });

  it('a save that omits the fields keeps them', async () => {
    const agent = await harness.loginAs(harness.limited);
    await agent
      .post('/push/preferences')
      .send({ sourceId: harness.sourceA, messageTextMaxPush: 250 })
      .expect(200);
    await agent
      .post('/push/preferences')
      .send({ sourceId: harness.sourceA, enableWebPush: false })
      .expect(200);
    const read = await agent.get(`/push/preferences?sourceId=${harness.sourceA}`);
    expect(read.body.messageTextMaxPush).toBe(250);
  });

  it.each([
    ['below the range', 19],
    ['above the range', 1001],
    ['not a whole number', 100.5],
    ['a numeric string', '250'],
    ['a boolean', true],
    ['NaN-like text', 'abc'],
  ])('rejects %s with 400', async (_label, value) => {
    const agent = await harness.loginAs(harness.limited);
    for (const field of ['messageTextMaxPush', 'messageTextMaxApprise']) {
      const res = await agent
        .post('/push/preferences')
        .send({ sourceId: harness.sourceA, [field]: value });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ success: false, code: 'INVALID_MESSAGE_TEXT_MAX', field });
    }
    const read = await agent.get(`/push/preferences?sourceId=${harness.sourceA}`);
    expect(read.body.messageTextMaxPush).toBeNull();
  });
});
