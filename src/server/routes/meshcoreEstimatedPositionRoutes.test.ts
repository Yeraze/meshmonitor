/**
 * MeshCore estimated-positions route (#6260 WP5) on the real route harness.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import routes from './meshcoreEstimatedPositionRoutes.js';

const A = 'a'.repeat(64);
const T = 'd'.repeat(64);

describe('GET /meshcore/estimated-positions', () => {
  let harness: RouteTestHarness;
  // The harness grant() sets one flag per row; this route needs read + viewOnMap.
  const setNodes = async (canRead: boolean, canViewOnMap: boolean) => {
    await harness.db.auth.createPermission({
      userId: harness.limited.id, resource: 'nodes', canRead, canWrite: false, canViewOnMap,
      sourceId: harness.sourceA, grantedAt: Date.now(), grantedBy: null,
    } as never);
  };
  const url = (s: string) => `/api/sources/${s}/meshcore/estimated-positions`;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app: express.Express) => app.use('/api/sources/:id/meshcore', routes),
    });
    await harness.db.meshcore.upsertNode({ publicKey: A, name: 'anchor', latitude: 10, longitude: 20, } as never, harness.sourceA);
    await harness.db.meshcore.upsertNode({ publicKey: T, name: 'target', } as never, harness.sourceA);
    await harness.db.meshcore.insertNeighborsBatch(harness.sourceA, T, [
      { neighborPublicKey: A, snr: 6, lastHeardSecs: 10 },
    ] as never);
    // Raise the limit so the lone-anchor 5 km radius is kept.
    await harness.db.settings.setSetting('position_estimation_max_uncertainty_km', '0');
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('returns the estimate for an admin', async () => {
    const admin = await harness.loginAs(harness.admin);
    const res = await admin.get(url(harness.sourceA));
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0]).toMatchObject({ publicKey: T, latitude: 10, longitude: 20, radiusMethod: 'single_anchor' });
  });

  it('is empty without nodes:viewOnMap and needs nodes:read on this source', async () => {
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.get(url(harness.sourceA))).status).toBe(403);
    await setNodes(true, false);
    const res = await agent.get(url(harness.sourceA));
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
    await harness.revokeAll(harness.limited.id);
    await setNodes(true, true);
    expect((await agent.get(url(harness.sourceA))).body.data.items).toHaveLength(1);
  });

  it('is scoped to the requested source', async () => {
    const admin = await harness.loginAs(harness.admin);
    const res = await admin.get(url(harness.sourceB));
    expect(res.body.data.items).toEqual([]);
  });

  it('drops a private-override anchor for a viewer without nodes_private', async () => {
    await harness.db.meshcore.upsertNode({ publicKey: A, name: 'anchor', } as never, harness.sourceA);
    await harness.db.meshcore.setNodePositionOverride(harness.sourceA, A, { enabled: true, latitude: 10, longitude: 20, isPrivate: true });
    await setNodes(true, true);
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.get(url(harness.sourceA))).body.data.items).toEqual([]);
    await harness.grant(harness.limited.id, 'nodes_private', 'read', harness.sourceA);
    expect((await agent.get(url(harness.sourceA))).body.data.items).toHaveLength(1);
  });
});
