/**
 * Poll Routes Integration Tests
 *
 * GET /poll is the consolidated polling endpoint (nodes, messages, unread
 * counts, channels, telemetry availability, config, device config,
 * traceroutes, device node numbers) moved out of server.ts as part of
 * #3502 PR1. This is a smoke test of the real router via the route-test
 * harness — no prior test exercised this handler directly (server.poll.test.ts
 * hand-rolls a duplicate mini-app that never imports pollRoutes.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import pollRoutes from './pollRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

describe('pollRoutes — GET /poll', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/', pollRoutes),
    });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('returns 200 with the aggregate poll shape for an authenticated admin', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/poll');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('connection');
    expect(res.body).toHaveProperty('nodes');
    expect(Array.isArray(res.body.nodes)).toBe(true);
    expect(res.body).toHaveProperty('unreadCounts');
    expect(res.body).toHaveProperty('channels');
    expect(res.body).toHaveProperty('config');
    expect(res.body).toHaveProperty('deviceNodeNums');
    expect(Array.isArray(res.body.deviceNodeNums)).toBe(true);
  });

  it('returns 200 with the aggregate poll shape for an anonymous caller', async () => {
    const agent = await harness.loginAs(null);
    const res = await agent.get('/poll');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('connection');
    expect(res.body).toHaveProperty('nodes');
    expect(Array.isArray(res.body.nodes)).toBe(true);
    expect(res.body).toHaveProperty('config');
    // Anonymous callers must not see the node IP / device metadata.
    expect(res.body.config).not.toHaveProperty('meshtasticNodeIp');
    expect(res.body.config).not.toHaveProperty('deviceMetadata');
  });

  it('scopes to a sourceId when provided and reports a clean disconnected state for an unregistered source', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/poll').query({ sourceId: 'rt-source-a' });

    expect(res.status).toBe(200);
    // No live manager is registered for rt-source-a in this test process,
    // so the handler must report a clean disconnected state rather than
    // leaking the legacy singleton's status (issue #2773).
    expect(res.body.connection).toEqual({
      connected: false,
      nodeResponsive: false,
      configuring: false,
      userDisconnected: false,
    });
  });

  it('#4412 Phase 2: derives the recent-traceroutes limit from the per-source maxNodeAgeHours', async () => {
    // No explicit ?limit=, so the handler must fall through to computing a
    // default limit from tracerouteIntervalMinutes * maxNodeAgeHours. Source A
    // is configured with a 1h window (clamps to the 100-row floor); Source B
    // with a 168h window (yields a much larger derived limit). Both sources
    // sharing the same tiny window would mean the per-source read regressed
    // back to a single global value.
    await harness.db.settings.setSourceSettings(harness.sourceA, { maxNodeAgeHours: '1' });
    await harness.db.settings.setSourceSettings(harness.sourceB, { maxNodeAgeHours: '168' });

    const getAllTraceroutesSpy = vi
      .spyOn(harness.db.traceroutes, 'getAllTraceroutes')
      .mockResolvedValue([]);

    const agent = await harness.loginAs(harness.admin);
    await agent.get('/poll').query({ sourceId: harness.sourceA });
    await agent.get('/poll').query({ sourceId: harness.sourceB });

    const limitsBySourceId = new Map(
      getAllTraceroutesSpy.mock.calls.map(([limit, sourceId]) => [sourceId, limit])
    );

    expect(limitsBySourceId.get(harness.sourceA)).toBe(100); // floor
    expect(limitsBySourceId.get(harness.sourceB)).toBe(2218); // ceil(12 * 168 * 1.1)
    expect(limitsBySourceId.get(harness.sourceA)).not.toBe(limitsBySourceId.get(harness.sourceB));

    getAllTraceroutesSpy.mockRestore();
  });
});
