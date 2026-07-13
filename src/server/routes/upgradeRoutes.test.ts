/**
 * Upgrade Routes tests — retired 410 stubs (Auto-Upgrade Retirement, v4.13).
 *
 * The router no longer performs any upgrade work; every endpoint returns
 * `410 Gone` with the shared `fail()` envelope so older frontends get a clean
 * machine-readable response (and a docs link) instead of 404 HTML.
 *
 * Uses the real route test harness (createRouteTestApp) per CLAUDE.md.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import upgradeRoutes from './upgradeRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

describe('upgradeRoutes (retired)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/api/upgrade', upgradeRoutes),
    });
  });

  afterEach(() => harness.cleanup());

  const endpoints: Array<{ method: 'get' | 'post'; path: string }> = [
    { method: 'post', path: '/api/upgrade/trigger' },
    { method: 'post', path: '/api/upgrade/cancel/00000000-0000-0000-0000-000000000000' },
    { method: 'post', path: '/api/upgrade/clear-block' },
    { method: 'get', path: '/api/upgrade/status' },
    { method: 'get', path: '/api/upgrade/status/00000000-0000-0000-0000-000000000000' },
    { method: 'get', path: '/api/upgrade/history' },
    { method: 'get', path: '/api/upgrade/latest-status' },
    { method: 'get', path: '/api/upgrade/test-configuration' },
  ];

  for (const { method, path } of endpoints) {
    it(`${method.toUpperCase()} ${path} → 410 FEATURE_RETIRED`, async () => {
      const agent = await harness.loginAs(harness.admin);
      const res =
        method === 'post' ? await agent.post(path).send({}) : await agent.get(path);

      expect(res.status).toBe(410);
      expect(res.body).toMatchObject({
        success: false,
        code: 'FEATURE_RETIRED',
      });
      expect(res.body.error).toContain(
        'https://yeraze.github.io/meshmonitor/configuration/updating',
      );
    });
  }

  it('still requires authentication (401 when unauthenticated)', async () => {
    const agent = await harness.loginAs(null);
    const res = await agent.post('/api/upgrade/trigger').send({});
    expect(res.status).toBe(401);
  });
});
