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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

/**
 * Coverage Report RF receptions are cleaned up with the source (#5277
 * amendment 5 / D7) — same failure mode as the node/beacon-offer purges
 * above: `deleteSource` alone would leave that source's `coverage_receptions`
 * rows behind forever, with no UI path left to reach them.
 */
describe('DELETE /api/sources/:id — coverage receptions cleanup (#5277)', () => {
  let harness: RouteTestHarness;

  const receptionParams = (sourceId: string, receiverId: string, senderId: string, packetKey: string) => ({
    sourceId,
    protocol: 'meshtastic',
    receiverKind: 'local',
    receiverId,
    senderId,
    packetKey,
    pathKey: 'r0:h0',
    latitude: 37.0,
    longitude: -122.0,
    receivedAt: Date.now(),
  });

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', sourceRoutes) });
    await harness.grant(harness.limited.id, 'sources', 'write');

    await databaseService.coverageReceptions.recordReception(
      receptionParams(harness.sourceA, '!0000cova', '!0000send', 'pkt-cov-del-1'),
    );
    await databaseService.coverageReceptions.recordReception(
      receptionParams(harness.sourceB, '!0000covb', '!0000send', 'pkt-cov-del-2'),
    );
  });

  afterEach(async () => {
    await databaseService.coverageReceptions.deleteForSource(harness.sourceA).catch(() => {});
    await databaseService.coverageReceptions.deleteForSource(harness.sourceB).catch(() => {});
    await harness.cleanup();
  });

  it('purges the deleted source\'s coverage receptions and leaves other sources alone', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.delete(`/${harness.sourceA}`);
    expect(res.status).toBe(200);

    const pageA = await databaseService.coverageReceptions.getReceptions({
      sourceIds: [harness.sourceA], sinceMs: 0, untilMs: Date.now() + 1000, pageSize: 10,
    });
    expect(pageA.items).toEqual([]);

    const pageB = await databaseService.coverageReceptions.getReceptions({
      sourceIds: [harness.sourceB], sinceMs: 0, untilMs: Date.now() + 1000, pageSize: 10,
    });
    expect(pageB.items.length).toBe(1);
  });
});

/**
 * Per-source secrets are cleaned up with the source (#5596).
 *
 * `meshcore_observer_keys`, `meshcore_observer_credentials` and
 * `source_pki_keys` each hold one row per source, keyed by source id, outside
 * `sources.config`. Nothing removed them on delete, so an encrypted signing
 * key, broker passwords and a PKI private key outlived the source they
 * belonged to, with no UI path left to reach them.
 *
 * They are NOT cleared by purgeAllNodesAsync: that helper also backs the
 * "purge nodes" action on a live source, which must leave the keys alone.
 */
describe('DELETE /api/sources/:id — per-source secret cleanup (#5596)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', sourceRoutes) });
    await harness.grant(harness.limited.id, 'sources', 'write');

    for (const [src, tag] of [[harness.sourceA, 'a'], [harness.sourceB, 'b']] as const) {
      await databaseService.meshcoreObserverKeys.upsert(src, `envelope-${tag}`, `PUB${tag}`, 'manual');
      await databaseService.meshcoreObserverCredentials.upsert(src, `user-${tag}`, `enc-pass-${tag}`);
      await databaseService.sourcePkiKeys.upsert(src, null, `pki-envelope-${tag}`, `pkipub-${tag}`);
    }
  });

  afterEach(async () => {
    for (const src of [harness.sourceA, harness.sourceB]) {
      await databaseService.meshcoreObserverKeys.deleteBySourceId(src).catch(() => {});
      await databaseService.meshcoreObserverCredentials.deleteBySourceId(src).catch(() => {});
      await databaseService.sourcePkiKeys.deleteBySourceId(src).catch(() => {});
    }
    await harness.cleanup();
  });

  it('removes the deleted source\'s Analyzer Observer key row', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.delete(`/${harness.sourceA}`);
    expect(res.status).toBe(200);

    expect(await databaseService.meshcoreObserverKeys.getBySourceId(harness.sourceA)).toBeNull();
    expect(await databaseService.meshcoreObserverKeys.hasKey(harness.sourceA)).toBe(false);
  });

  it('leaves another source\'s Analyzer Observer key untouched', async () => {
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.delete(`/${harness.sourceA}`)).status).toBe(200);

    const keyB = await databaseService.meshcoreObserverKeys.getBySourceId(harness.sourceB);
    expect(keyB).not.toBeNull();
    expect(keyB!.encryptedPrivateKey).toBe('envelope-b');
    expect(keyB!.publicKey).toBe('PUBb');
  });

  it('removes the deleted source\'s Observer credentials and PKI key, and only those', async () => {
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.delete(`/${harness.sourceA}`)).status).toBe(200);

    expect(await databaseService.meshcoreObserverCredentials.getBySourceId(harness.sourceA)).toBeNull();
    expect(await databaseService.sourcePkiKeys.getBySourceId(harness.sourceA)).toBeNull();

    expect(await databaseService.meshcoreObserverCredentials.getBySourceId(harness.sourceB)).not.toBeNull();
    expect(await databaseService.sourcePkiKeys.getBySourceId(harness.sourceB)).not.toBeNull();
  });

  it('a failed key purge does not fail the delete or skip the other purges', async () => {
    const spy = vi
      .spyOn(databaseService.meshcoreObserverKeys, 'deleteBySourceId')
      .mockRejectedValueOnce(new Error('disk on fire'));
    try {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.delete(`/${harness.sourceA}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(await databaseService.meshcoreObserverCredentials.getBySourceId(harness.sourceA)).toBeNull();
      expect(await databaseService.sourcePkiKeys.getBySourceId(harness.sourceA)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('a node purge on a live source keeps its keys', async () => {
    // The reason this cleanup lives in the delete route and not in the purge
    // helper: purging nodes is routine maintenance on a source that stays.
    await databaseService.purgeAllNodesAsync(harness.sourceA);

    expect(await databaseService.meshcoreObserverKeys.getBySourceId(harness.sourceA)).not.toBeNull();
    expect(await databaseService.meshcoreObserverCredentials.getBySourceId(harness.sourceA)).not.toBeNull();
    expect(await databaseService.sourcePkiKeys.getBySourceId(harness.sourceA)).not.toBeNull();
  });
});
