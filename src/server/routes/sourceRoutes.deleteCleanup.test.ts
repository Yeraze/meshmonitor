/**
 * DELETE /api/sources/:id — orphaned node cleanup (issue #4137).
 *
 * Background: deleteSource() only removes the `sources` row. Historically it
 * left that source's `nodes` rows (and hence their `hideFromMap` flag) behind
 * forever, with no UI path to clean them up once the owning source was gone.
 * Since mergeNodesAcrossSources ORs hideFromMap across every row for a
 * nodeNum (including orphans), those stale rows could keep a node hidden in
 * every cross-source/unified consumer permanently. The route now
 * best-effort purges that source's node rows via purgeAllNodesAsync
 * immediately after a successful delete.
 *
 * Uses the real-middleware harness (createRouteTestApp) against the live
 * :memory: singleton DB — see src/server/test-helpers/routeTestApp.ts for
 * the design rationale, and src/server/routes/sourceRoutes.permissions.test.ts
 * for the template this file follows. purgeAllNodesAsync is NOT mocked: it
 * runs for real so the assertions prove the actual purge, not a mocked call.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import sourceRoutes from './sourceRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';

function nodeIdFor(num: number): string {
  return `!${num.toString(16).padStart(8, '0')}`;
}

describe('DELETE /api/sources/:id — orphaned node cleanup (#4137)', () => {
  let harness: RouteTestHarness;

  const NODE_A = 0x50000001; // seeded on sourceA — should be purged
  const NODE_B = 0x50000002; // seeded on sourceB — must survive sourceA's deletion

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/', sourceRoutes),
    });

    // DELETE /:id uses requirePermission('sources', 'write') with no
    // sourceIdFrom option — a GLOBAL permission check.
    await harness.grant(harness.limited.id, 'sources', 'write');

    await databaseService.upsertNodeAsync(
      {
        nodeNum: NODE_A,
        nodeId: nodeIdFor(NODE_A),
        longName: 'Node A',
        shortName: 'NDA',
        hwModel: 1,
        hideFromMap: true,
        lastHeard: Math.floor(Date.now() / 1000),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any,
      harness.sourceA,
    );

    await databaseService.upsertNodeAsync(
      {
        nodeNum: NODE_B,
        nodeId: nodeIdFor(NODE_B),
        longName: 'Node B',
        shortName: 'NDB',
        hwModel: 1,
        lastHeard: Math.floor(Date.now() / 1000),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any,
      harness.sourceB,
    );
  });

  afterEach(async () => {
    await databaseService.nodes.deleteAllNodes(harness.sourceB).catch(() => {});
    await harness.cleanup();
  });

  it('purges node rows for the deleted source, leaving other sources untouched', async () => {
    const agent = await harness.loginAs(harness.limited);

    const res = await agent.delete(`/${harness.sourceA}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // sourceA's node row is gone — no longer able to leak a stale hideFromMap
    // into the unified merge.
    expect(await databaseService.nodes.getNode(NODE_A, harness.sourceA)).toBeNull();

    // sourceB is untouched: the purge must be scoped to the deleted source only.
    const nodeB = await databaseService.nodes.getNode(NODE_B, harness.sourceB);
    expect(nodeB).not.toBeNull();
    expect(nodeB!.nodeNum).toBe(NODE_B);
  });

  it('still deletes the source even if the purge is skipped for an already-clean source', async () => {
    // sourceB has no orphan risk here — deleting it should succeed and the
    // purge call (0 rows affected) must not fail the request.
    const agent = await harness.loginAs(harness.limited);

    const res = await agent.delete(`/${harness.sourceB}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

/**
 * Beacon offers are cleaned up with the source (#4723).
 *
 * Same failure mode as the node and settings purges above, with a twist: the
 * rows carry the user's DISMISSALS. A future source reusing the id would
 * inherit invitations the previous owner had already declined and keep them
 * hidden — silent, and hard to trace back to a source deleted months earlier.
 */
describe('DELETE /api/sources/:id — beacon offer cleanup (#4723)', () => {
  let harness: RouteTestHarness;
  const BEACON_NODE = 0x50000009;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', sourceRoutes) });
    await harness.grant(harness.limited.id, 'sources', 'write');

    for (const src of [harness.sourceA, harness.sourceB]) {
      await databaseService.meshBeaconOffers.recordBeacon(src, BEACON_NODE, {
        message: 'join us',
        offerChannelName: 'RegionMesh',
        offerChannelPsk: 'AQIDBAUGBwgJCgsMDQ4PEA==',
        offerRegion: 1,
        offerPreset: 0,
      }, Date.now());
    }
  });

  afterEach(async () => {
    await databaseService.meshBeaconOffers.deleteForSource(harness.sourceA).catch(() => {});
    await databaseService.meshBeaconOffers.deleteForSource(harness.sourceB).catch(() => {});
    await harness.cleanup();
  });

  it('purges the deleted source\'s offers and leaves other sources alone', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.delete(`/${harness.sourceA}`);
    expect(res.status).toBe(200);

    expect(await databaseService.meshBeaconOffers.listAll(harness.sourceA)).toHaveLength(0);
    expect(await databaseService.meshBeaconOffers.listAll(harness.sourceB)).toHaveLength(1);
  });
});
