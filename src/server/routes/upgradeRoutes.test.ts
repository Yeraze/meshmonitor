/**
 * Upgrade Routes tests — routes fully removed (Auto-Upgrade Retirement Phase 3, v4.14).
 *
 * v4.13 kept `/api/upgrade/*` mounted as `410 Gone` stubs for one grace-period
 * release. v4.14 removes the router entirely (issue #4117), so those paths now
 * fall through to a plain 404 like any unknown route — no more 410 stubs.
 *
 * Uses the real route test harness (createRouteTestApp) per CLAUDE.md.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

describe('upgradeRoutes (removed in 4.14)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    // No `/api/upgrade` mount — the router is gone. Mount only a health marker
    // so the harness app is otherwise valid.
    harness = await createRouteTestApp({
      mount: (app) => app.get('/api/health', (_req, res) => res.json({ ok: true })),
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
    it(`${method.toUpperCase()} ${path} → 404 (not 410)`, async () => {
      const agent = await harness.loginAs(harness.admin);
      const res =
        method === 'post' ? await agent.post(path).send({}) : await agent.get(path);

      // Router removed entirely — no 410 FEATURE_RETIRED stub anymore.
      expect(res.status).toBe(404);
      expect(res.body?.code).not.toBe('FEATURE_RETIRED');
    });
  }
});
