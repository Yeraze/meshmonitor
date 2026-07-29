/**
 * GET /api/unified/dashboard — maxNodeAgeHours is per-source as of #4412
 * Phase 2 WP2. The fan-out over N sources must stay a single batched
 * `getSettingForSources()` read (not one query per source, and not
 * `getSourceSettings()` — a full-table scan per source, #4419).
 *
 * Uses the real-middleware harness (createRouteTestApp) per CLAUDE.md.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import unifiedRoutes from './unifiedRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

describe('GET /api/unified/dashboard — per-source maxNodeAgeHours (#4412 Phase 2 WP2)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      // unifiedRoutes.ts already applies its own `router.use(optionalAuth())`;
      // skip the harness's copy to avoid mounting it twice.
      useOptionalAuth: false,
      mount: (app) => app.use('/api/unified', unifiedRoutes),
    });
  });

  afterEach(async () => {
    await harness.db.neighbors.deleteAllNeighborInfo(harness.sourceA).catch(() => {});
    await harness.db.neighbors.deleteAllNeighborInfo(harness.sourceB).catch(() => {});
    await harness.db.settings.deleteSourceSettings(harness.sourceA).catch(() => {});
    await harness.db.settings.deleteSourceSettings(harness.sourceB).catch(() => {});
    await harness.cleanup();
  });

  it('bundles per source with different neighborInfo lengths, in one batched settings query', async () => {
    const now = Math.floor(Date.now() / 1000);
    await harness.db.settings.setSourceSettings(harness.sourceA, { maxNodeAgeHours: '1' });
    await harness.db.settings.setSourceSettings(harness.sourceB, { maxNodeAgeHours: '168' });

    const twentyFourHoursAgo = now - 24 * 3600;
    for (const sourceId of [harness.sourceA, harness.sourceB]) {
      await harness.db.nodes.upsertNode({ nodeNum: 111, nodeId: '!0000006f', longName: 'Alpha' }, sourceId);
      await harness.db.nodes.upsertNode({ nodeNum: 222, nodeId: '!000000de', longName: 'Beta' }, sourceId);
      await harness.db.neighbors.insertNeighborInfo(
        { nodeNum: 111, neighborNodeNum: 222, timestamp: twentyFourHoursAgo * 1000, createdAt: now },
        sourceId,
      );
    }

    const spy = vi.spyOn(harness.db.settings, 'getSettingForSources');

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/api/unified/dashboard?sources=${harness.sourceA},${harness.sourceB}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);

    const bundleA = res.body.find((b: any) => b.sourceId === harness.sourceA);
    const bundleB = res.body.find((b: any) => b.sourceId === harness.sourceB);
    expect(bundleA.neighborInfo).toHaveLength(0);
    expect(bundleB.neighborInfo).toHaveLength(1);

    // One batched IN() read for the whole selection, not one per source.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.arrayContaining([harness.sourceA, harness.sourceB]),
      'maxNodeAgeHours',
    );

    spy.mockRestore();
  });
});
