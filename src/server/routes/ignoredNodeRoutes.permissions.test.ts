/**
 * Ignored Node Routes — reason-column + permission coverage (MQTT Geo-Ignore
 * epic, Phase 1, WP3).
 *
 * Uses the real-middleware harness (createRouteTestApp) instead of the
 * deprecated vi.mock('../../services/database.js', ...) monkey-patch used by
 * ignoredNodeRoutes.test.ts, per CLAUDE.md's Route Test Harness guidance.
 * Seeds ignored-node rows through the real repository
 * (databaseService.ignoredNodes.addIgnoredNodeAsync / addGeoIgnoreAsync) so
 * the `reason` column flows through GET / DELETE exactly as it would in
 * production, and exercises the real requirePermission('nodes', ...) gate.
 *
 * See src/server/test-helpers/routeTestApp.ts and
 * src/server/routes/sourceRoutes.permissions.test.ts (canonical template).
 */

import { describe, it, expect, afterEach } from 'vitest';
import ignoredNodeRoutes from './ignoredNodeRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const nodeIdFor = (nodeNum: number): string => `!${nodeNum.toString(16).padStart(8, '0')}`;

describe('ignoredNodeRoutes — reason surfacing + permissions', () => {
  let harness: RouteTestHarness;

  afterEach(async () => {
    // Cascades ignored_nodes rows for sourceA/sourceB (FK ON DELETE CASCADE).
    await harness.cleanup();
  });

  it('GET / returns both a manual and a geo row with correct reason values', async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', ignoredNodeRoutes) });
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);

    const manualNum = 0x0a0b0c01;
    const geoNum = 0x0a0b0c02;
    await harness.db.ignoredNodes.addIgnoredNodeAsync(
      manualNum,
      harness.sourceA,
      nodeIdFor(manualNum),
      'Manual Node',
      'MAN',
      'admin'
    );
    await harness.db.ignoredNodes.addGeoIgnoreAsync(
      geoNum,
      harness.sourceA,
      nodeIdFor(geoNum),
      'Geo Node',
      'GEO'
    );

    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/?sourceId=${harness.sourceA}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    const byNum: Record<number, any> = Object.fromEntries(
      res.body.map((row: any) => [row.nodeNum, row])
    );
    expect(byNum[manualNum].reason).toBe('manual');
    expect(byNum[geoNum].reason).toBe('geo');
  });

  it('DELETE /:nodeId removes a geo row (200) and it no longer appears in GET', async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', ignoredNodeRoutes) });
    // Single row with both flags set — the permissions table has a UNIQUE
    // constraint on (userId, resource, sourceId), so two harness.grant()
    // calls for the same resource+source (one per action) would collide.
    await harness.db.auth.createPermission({
      userId: harness.limited.id,
      resource: 'nodes',
      canRead: true,
      canWrite: true,
      canViewOnMap: false,
      sourceId: harness.sourceA,
      grantedAt: Date.now(),
      grantedBy: null,
    });

    const geoNum = 0x0a0b0c03;
    await harness.db.ignoredNodes.addGeoIgnoreAsync(
      geoNum,
      harness.sourceA,
      nodeIdFor(geoNum),
      'Geo Node',
      'GEO'
    );

    const agent = await harness.loginAs(harness.limited);

    const delRes = await agent.delete(`/${nodeIdFor(geoNum)}?sourceId=${harness.sourceA}`);
    expect(delRes.status).toBe(200);
    expect(delRes.body).toMatchObject({ success: true, nodeNum: geoNum, sourceId: harness.sourceA });

    const getRes = await agent.get(`/?sourceId=${harness.sourceA}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body).toEqual([]);
  });

  it('GET / without nodes:read → 403', async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', ignoredNodeRoutes) });
    // No grants at all for the limited user.

    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/?sourceId=${harness.sourceA}`);

    expect(res.status).toBe(403);
  });

  it('DELETE /:nodeId without nodes:write → 403', async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', ignoredNodeRoutes) });
    // Read-only grant — no write permission.
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);

    const geoNum = 0x0a0b0c04;
    await harness.db.ignoredNodes.addGeoIgnoreAsync(
      geoNum,
      harness.sourceA,
      nodeIdFor(geoNum),
      'Geo Node',
      'GEO'
    );

    const agent = await harness.loginAs(harness.limited);
    const res = await agent.delete(`/${nodeIdFor(geoNum)}?sourceId=${harness.sourceA}`);

    expect(res.status).toBe(403);
  });
});
