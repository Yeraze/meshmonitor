/**
 * Nodes Routes Integration Tests
 *
 * The 20 `/nodes*` + `/auto-favorite/status` handlers (plus
 * `/auto-ping/stop/:nodeNum`) moved out of server.ts as part of #3502 PR3
 * were previously covered only by server.test.ts's hand-rolled mini-app
 * duplicate (which never imports nodesRoutes.ts). This is the first real
 * coverage of the actual router via the route-test harness
 * (createRouteTestApp): a permissioned write, an optionalAuth read, and the
 * requireSourceId('query') gate on the position-override GET.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import nodesRoutes from './nodesRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

describe('nodesRoutes — POST /nodes/:nodeId/favorite (permissioned write)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/', nodesRoutes),
    });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('403s a caller without nodes:write on the target source', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post('/nodes/!aabbccdd/favorite').send({
      isFavorite: true,
      syncToDevice: false,
      sourceId: harness.sourceA,
    });
    expect(res.status).toBe(403);
  });

  it('200s and persists the favorite for a caller with nodes:write on the source', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);

    const res = await agent.post('/nodes/!aabbccdd/favorite').send({
      isFavorite: true,
      syncToDevice: false,
      sourceId: harness.sourceA,
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      nodeNum: 0xaabbccdd,
      isFavorite: true,
    });
    expect(res.body.deviceSync).toMatchObject({ status: 'skipped' });
  });
});

describe('nodesRoutes — GET /nodes (optionalAuth read)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/', nodesRoutes),
    });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('200s with an array for an anonymous caller (no permission grant needed)', async () => {
    const agent = await harness.loginAs(null);
    const res = await agent.get('/nodes');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('200s with an array for an authenticated admin', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/nodes');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('nodesRoutes — GET /nodes/:nodeId/position-override (requireSourceId gate)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/', nodesRoutes),
    });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('400s with MISSING_SOURCE_ID when sourceId query param is absent', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/nodes/!aabbccdd/position-override');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_SOURCE_ID' });
  });

  it('passes the requireSourceId gate and reaches the handler when sourceId is present', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent
      .get('/nodes/!aabbccdd/position-override')
      .query({ sourceId: harness.sourceA });
    // No override has been set for this node — the handler itself 404s,
    // proving requireSourceId let the request through rather than
    // short-circuiting on the missing-sourceId path.
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NODE_NOT_FOUND' });
  });
});
