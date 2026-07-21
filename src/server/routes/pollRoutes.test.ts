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
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
});
