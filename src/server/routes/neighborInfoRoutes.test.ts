/**
 * GET /api/neighbor-info — per-source maxNodeAgeHours (#4412 Phase 2 WP2).
 *
 * Converted to the real-middleware harness (createRouteTestApp) per CLAUDE.md
 * ("New or changed route tests MUST use the harness"). The previous version of
 * this file mocked `databaseService.settings.getSetting('maxNodeAge')` — the
 * exact same dead key (not in VALID_SETTINGS_KEYS) that the route itself read
 * — so the test re-implemented the bug instead of catching it (the anti-
 * pattern CLAUDE.md bans: "a fake that re-implements the logic under test
 * cannot catch regressions in that logic"). The route now resolves the real
 * `maxNodeAgeHours` key per-source via `getMaxNodeAgeHours()`; this suite
 * seeds real settings/node/neighbor rows and asserts on the real router.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import neighborInfoRoutes from './neighborInfoRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

describe('neighborInfoRoutes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/', neighborInfoRoutes),
    });
  });

  afterEach(async () => {
    await harness.db.neighbors.deleteAllNeighborInfo(harness.sourceA).catch(() => {});
    await harness.db.neighbors.deleteAllNeighborInfo(harness.sourceB).catch(() => {});
    await harness.db.settings.deleteSourceSettings(harness.sourceA).catch(() => {});
    await harness.db.settings.deleteSourceSettings(harness.sourceB).catch(() => {});
    await harness.cleanup();
  });

  describe('GET /', () => {
    it('returns enriched neighbor info within the default 24h window', async () => {
      const now = Math.floor(Date.now() / 1000);
      await harness.db.nodes.upsertNode({ nodeNum: 111, nodeId: '!0000006f', longName: 'Alpha' }, harness.sourceA);
      await harness.db.nodes.upsertNode({ nodeNum: 222, nodeId: '!000000de', longName: 'Beta' }, harness.sourceA);
      await harness.db.neighbors.insertNeighborInfo(
        { nodeNum: 111, neighborNodeNum: 222, timestamp: now * 1000, createdAt: now },
        harness.sourceA,
      );

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/?sourceId=${harness.sourceA}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].nodeName).toBe('Alpha');
      expect(res.body[0].neighborName).toBe('Beta');
    });

    it('honours a per-source maxNodeAgeHours override — pins the dead-key fix (#4412 bug 1)', async () => {
      // Narrow sourceA's window to 1h; the link is 2h old, so it must be
      // filtered out. Before the fix the route read the dead 'maxNodeAge' key
      // (always null) and silently fell back to a hardcoded 24h window no
      // matter what maxNodeAgeHours was configured to.
      const now = Math.floor(Date.now() / 1000);
      await harness.db.settings.setSourceSettings(harness.sourceA, { maxNodeAgeHours: '1' });
      await harness.db.nodes.upsertNode({ nodeNum: 111, nodeId: '!0000006f', longName: 'Alpha' }, harness.sourceA);
      await harness.db.nodes.upsertNode({ nodeNum: 222, nodeId: '!000000de', longName: 'Beta' }, harness.sourceA);
      const twoHoursAgo = now - 2 * 3600;
      await harness.db.neighbors.insertNeighborInfo(
        { nodeNum: 111, neighborNodeNum: 222, timestamp: twoHoursAgo * 1000, createdAt: now },
        harness.sourceA,
      );

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/?sourceId=${harness.sourceA}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(0);
    });

    it('two sources with different maxNodeAgeHours filter the same-age link differently (per-source proof)', async () => {
      const now = Math.floor(Date.now() / 1000);
      await harness.db.settings.setSourceSettings(harness.sourceA, { maxNodeAgeHours: '1' });
      await harness.db.settings.setSourceSettings(harness.sourceB, { maxNodeAgeHours: '168' });
      const twoHoursAgo = now - 2 * 3600;

      for (const sourceId of [harness.sourceA, harness.sourceB]) {
        await harness.db.nodes.upsertNode({ nodeNum: 111, nodeId: '!0000006f', longName: 'Alpha' }, sourceId);
        await harness.db.nodes.upsertNode({ nodeNum: 222, nodeId: '!000000de', longName: 'Beta' }, sourceId);
        await harness.db.neighbors.insertNeighborInfo(
          { nodeNum: 111, neighborNodeNum: 222, timestamp: twoHoursAgo * 1000, createdAt: now },
          sourceId,
        );
      }

      const agent = await harness.loginAs(harness.admin);
      const resA = await agent.get(`/?sourceId=${harness.sourceA}`);
      const resB = await agent.get(`/?sourceId=${harness.sourceB}`);

      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);
      expect(resA.body).toHaveLength(0);
      expect(resB.body).toHaveLength(1);
    });

    it('marks links as bidirectional when reverse link exists', async () => {
      const now = Math.floor(Date.now() / 1000);
      await harness.db.nodes.upsertNode({ nodeNum: 111, nodeId: '!0000006f', longName: 'Node' }, harness.sourceA);
      await harness.db.neighbors.insertNeighborInfo(
        { nodeNum: 111, neighborNodeNum: 222, timestamp: now * 1000, createdAt: now },
        harness.sourceA,
      );
      await harness.db.neighbors.insertNeighborInfo(
        { nodeNum: 222, neighborNodeNum: 111, timestamp: now * 1000, createdAt: now },
        harness.sourceA,
      );

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/?sourceId=${harness.sourceA}`);

      expect(res.status).toBe(200);
      expect(res.body[0].bidirectional).toBe(true);
    });

    it('surfaces a position override in nodeLatitude/nodeLongitude (mirrors the old server.neighbor-info-position.test.ts coverage)', async () => {
      const now = Math.floor(Date.now() / 1000);
      await harness.db.nodes.upsertNode({
        nodeNum: 111,
        nodeId: '!0000006f',
        longName: 'Overridden',
        latitude: 40.0,
        longitude: -75.0,
        positionOverrideEnabled: true,
        latitudeOverride: 41.0,
        longitudeOverride: -76.0,
      } as any, harness.sourceA);
      await harness.db.nodes.upsertNode({
        nodeNum: 222,
        nodeId: '!000000de',
        longName: 'Plain',
        latitude: 42.0,
        longitude: -77.0,
      }, harness.sourceA);
      await harness.db.neighbors.insertNeighborInfo(
        { nodeNum: 111, neighborNodeNum: 222, timestamp: now * 1000, createdAt: now },
        harness.sourceA,
      );

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/?sourceId=${harness.sourceA}`);

      expect(res.status).toBe(200);
      expect(res.body[0].nodeLatitude).toBe(41.0);
      expect(res.body[0].nodeLongitude).toBe(-76.0);
      expect(res.body[0].neighborLatitude).toBe(42.0);
      expect(res.body[0].neighborLongitude).toBe(-77.0);
    });

    it('returns 500 on database error', async () => {
      const spy = vi
        .spyOn(harness.db, 'getLatestNeighborInfoPerNodeScopedAsync')
        .mockRejectedValueOnce(new Error('db error'));

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/?sourceId=${harness.sourceA}`);

      expect(res.status).toBe(500);
      spy.mockRestore();
    });
  });

  describe('GET /:nodeNum', () => {
    it('returns enriched neighbor list for a node', async () => {
      const now = Math.floor(Date.now() / 1000);
      await harness.db.nodes.upsertNode({ nodeNum: 222, nodeId: '!000000de', longName: 'Beta' }, harness.sourceA);
      await harness.db.neighbors.insertNeighborInfo(
        { nodeNum: 111, neighborNodeNum: 222, timestamp: now * 1000, createdAt: now },
        harness.sourceA,
      );

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/111?sourceId=${harness.sourceA}`);

      expect(res.status).toBe(200);
      expect(res.body[0].neighborName).toBe('Beta');
    });

    it('falls back to hex id when node not found', async () => {
      const now = Math.floor(Date.now() / 1000);
      await harness.db.neighbors.insertNeighborInfo(
        { nodeNum: 111, neighborNodeNum: 0xdeadbeef, timestamp: now * 1000, createdAt: now },
        harness.sourceA,
      );

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/111?sourceId=${harness.sourceA}`);

      expect(res.body[0].neighborNodeId).toBe('!deadbeef');
    });

    it('returns 500 on database error', async () => {
      const spy = vi
        .spyOn(harness.db, 'getNeighborsForNodeAsync')
        .mockRejectedValueOnce(new Error('db error'));

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/111?sourceId=${harness.sourceA}`);

      expect(res.status).toBe(500);
      spy.mockRestore();
    });

    it('400s when sourceId is omitted', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/111');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('MISSING_SOURCE_ID');
    });
  });
});
