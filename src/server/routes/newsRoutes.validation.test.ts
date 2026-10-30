/**
 * Regression tests for #6086 — POST /news/user/status must reject a non-string
 * lastSeenNewsId. Without the type guard, SQLite coerces an integer like 99999
 * into the float string "99999.0", which never matches a real news ID and
 * permanently corrupts the user's news state.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import newsRoutes from './newsRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

describe('POST /news/user/status — lastSeenNewsId validation (#6086)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: app => app.use('/news', newsRoutes) });
  });

  afterEach(() => harness.cleanup());

  it('rejects a non-string (integer) lastSeenNewsId with 400', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post('/news/user/status').send({ lastSeenNewsId: 99999 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/lastSeenNewsId must be a string/);
  });

  it('rejects an object lastSeenNewsId with 400', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post('/news/user/status').send({ lastSeenNewsId: { evil: true } });
    expect(res.status).toBe(400);
  });

  it('accepts a string lastSeenNewsId', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent
      .post('/news/user/status')
      .send({ lastSeenNewsId: 'guid-123', dismissedNewsIds: [] });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('accepts null / absent lastSeenNewsId', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post('/news/user/status').send({ lastSeenNewsId: null });
    expect(res.status).toBe(200);

    const res2 = await agent.post('/news/user/status').send({});
    expect(res2.status).toBe(200);
  });
});
