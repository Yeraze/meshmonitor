/**
 * buildSourceNeighborInfo — maxNodeAgeHours is per-source as of #4412 Phase 2
 * WP2 (previously a single global `getMaxNodeAgeHours()` in this file).
 *
 * Headline per-source proof: two sources configured with different
 * `maxNodeAgeHours` values must apply different neighbor-info freshness
 * windows for otherwise-identical data. Uses the real singleton DB (via
 * createRouteTestApp's seeding, without mounting a router — this is a
 * service-level test, not a route test) so the real settings/nodes/neighbors
 * repositories are exercised end-to-end.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildSourceNeighborInfo } from './sourceDashboardData.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import type { User } from '../../types/auth.js';

describe('buildSourceNeighborInfo — per-source maxNodeAgeHours (#4412 Phase 2 WP2)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: () => {} });
  });

  afterEach(async () => {
    await harness.db.neighbors.deleteAllNeighborInfo(harness.sourceA).catch(() => {});
    await harness.db.neighbors.deleteAllNeighborInfo(harness.sourceB).catch(() => {});
    await harness.db.settings.deleteSourceSettings(harness.sourceA).catch(() => {});
    await harness.db.settings.deleteSourceSettings(harness.sourceB).catch(() => {});
    await harness.cleanup();
  });

  // Admin bypasses both the nodes:read gate (buildSourceDashboard) and the
  // internal filterNodesByChannelPermission/hasPermission calls inside
  // buildSourceNeighborInfo — only .isAdmin is read on that path, so the
  // SeededUser shape is sufficient here.
  const adminUser = () => harness.admin as unknown as User;

  it('two sources with different maxNodeAgeHours return different neighbor-info sets for the same-age link', async () => {
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

    const sourceARow = { id: harness.sourceA, name: 'Source A', type: 'meshtastic_tcp' };
    const sourceBRow = { id: harness.sourceB, name: 'Source B', type: 'meshtastic_tcp' };

    // sourceA's 1h window excludes the 24h-old report; sourceB's 168h window includes it.
    const linksA = await buildSourceNeighborInfo(sourceARow, adminUser());
    const linksB = await buildSourceNeighborInfo(sourceBRow, adminUser());

    expect(linksA).toHaveLength(0);
    expect(linksB).toHaveLength(1);
  });

  it('an explicit maxNodeAgeHours argument overrides the per-source setting (unified-dashboard batch path)', async () => {
    const now = Math.floor(Date.now() / 1000);
    await harness.db.settings.setSourceSettings(harness.sourceA, { maxNodeAgeHours: '1' });
    await harness.db.nodes.upsertNode({ nodeNum: 111, nodeId: '!0000006f', longName: 'Alpha' }, harness.sourceA);
    await harness.db.nodes.upsertNode({ nodeNum: 222, nodeId: '!000000de', longName: 'Beta' }, harness.sourceA);
    const twentyFourHoursAgo = now - 24 * 3600;
    await harness.db.neighbors.insertNeighborInfo(
      { nodeNum: 111, neighborNodeNum: 222, timestamp: twentyFourHoursAgo * 1000, createdAt: now },
      harness.sourceA,
    );

    const sourceARow = { id: harness.sourceA, name: 'Source A', type: 'meshtastic_tcp' };

    // The per-source setting (1h) would filter this link out; the explicit
    // argument (168h), as the unified dashboard fan-out passes in, must win.
    const links = await buildSourceNeighborInfo(sourceARow, adminUser(), 168);
    expect(links).toHaveLength(1);
  });
});
