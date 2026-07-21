/**
 * Admin Routes Integration Tests
 *
 * All 17 handlers moved out of server.ts as part of #3502 PR2 were previously
 * covered by zero real tests (server.test.ts hand-rolls a duplicate mini-app
 * that never imports adminRoutes.ts). This is the first real coverage of the
 * requireAdmin() gate plus one representative body-handling endpoint, via the
 * route-test harness (createRouteTestApp).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import adminRoutes from './adminRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

describe('adminRoutes — requireAdmin() gate', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/', adminRoutes),
    });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('GET /suppressed-ghosts → 403 for a logged-in non-admin user', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/suppressed-ghosts');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'FORBIDDEN_ADMIN' });
  });

  it('GET /suppressed-ghosts → 401 for an anonymous caller', async () => {
    const agent = await harness.loginAs(null);
    const res = await agent.get('/suppressed-ghosts');
    expect(res.status).toBe(401);
  });

  it('GET /suppressed-ghosts → 200 for an admin', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/suppressed-ghosts');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });
    expect(Array.isArray(res.body.suppressedNodes)).toBe(true);
  });
});

describe('adminRoutes — PUT /auto-favorite-targets/:nodeNum (body-handling)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/', adminRoutes),
    });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('403s for a non-admin caller (write blocked before body is even read)', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent
      .put('/auto-favorite-targets/12345')
      .send({ sourceId: harness.sourceA, enabled: true });
    expect(res.status).toBe(403);
  });

  it('400s when sourceId is missing from the body', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.put('/auto-favorite-targets/12345').send({ enabled: true });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining('sourceId') });
  });

  it('saves the config for an admin and GET reflects it back', async () => {
    const agent = await harness.loginAs(harness.admin);

    const putRes = await agent.put('/auto-favorite-targets/12345').send({
      sourceId: harness.sourceA,
      enabled: true,
      useNeighborInfo: false,
      intervalHours: 6,
      eligibleRoles: [2, 11],
    });
    expect(putRes.status).toBe(200);
    expect(putRes.body).toEqual({ success: true });

    const getRes = await agent
      .get('/auto-favorite-targets/12345')
      .query({ sourceId: harness.sourceA });
    expect(getRes.status).toBe(200);
    expect(getRes.body).toMatchObject({
      configured: true,
      sourceId: harness.sourceA,
      targetNodeNum: 12345,
      enabled: true,
      useNeighborInfo: false,
      intervalHours: 6,
      eligibleRoles: [2, 11],
    });
  });
});
