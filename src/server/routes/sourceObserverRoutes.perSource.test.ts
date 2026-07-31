/**
 * sourceObserverRoutes — cross-source permission isolation (#4457 Phase 1 WP4, spec §8.5)
 *
 * Uses the real `createRouteTestApp` harness (real session + real
 * `requirePermission` + real `checkPermissionAsync` SQL) against two
 * dedicated MeshCore sources — the harness's built-in `sourceA`/`sourceB`
 * are seeded as `meshtastic_tcp` (spec §1.9), so observer tests create their
 * own `meshcore` sources and grant against those ids.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import sourceRoutes from './sourceRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import {
  MeshCoreObserverKeyStore,
  setMeshCoreObserverKeyStoreForTesting,
} from '../services/meshcoreObserverKeyStore.js';

// Deterministic, valid, clamped orlp private key — same recipe as
// meshcoreObserverToken.test.ts (spec §8.3).
const seed = Buffer.alloc(32, 7);
const h = crypto.createHash('sha512').update(seed).digest();
h[0] &= 248;
h[31] &= 63;
h[31] |= 64;
const PRIV = h.toString('hex');

const mockSourceRegistry = vi.hoisted(() => ({
  getManager: vi.fn(),
}));
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: mockSourceRegistry,
}));

const OBS_A = 'obs-a';
const OBS_B = 'obs-b';

/**
 * `permissions` carries a UNIQUE(user_id, resource, sourceId) index (migration
 * 033) — one row per (user, resource, source). `harness.grant()` inserts a
 * fresh row per call, so granting 'read' then 'write' for the same
 * resource+source collides on that unique index. Grant both in one row via
 * the repository directly when a test needs both actions on the same source.
 */
async function grantReadWrite(harness: RouteTestHarness, userId: number, sourceId: string): Promise<void> {
  await harness.db.auth.createPermission({
    userId,
    resource: 'configuration',
    canRead: true,
    canWrite: true,
    sourceId,
    grantedAt: Date.now(),
    grantedBy: null,
  });
}

describe('sourceObserverRoutes — per-source permission isolation', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/api/sources', sourceRoutes),
    });
    await harness.db.sources.deleteSource(OBS_A).catch(() => {});
    await harness.db.sources.deleteSource(OBS_B).catch(() => {});
    await harness.db.sources.createSource({ id: OBS_A, name: 'Obs A', type: 'meshcore', config: {}, enabled: true });
    await harness.db.sources.createSource({ id: OBS_B, name: 'Obs B', type: 'meshcore', config: {}, enabled: true });

    mockSourceRegistry.getManager.mockReset();
    mockSourceRegistry.getManager.mockReturnValue(undefined);
    setMeshCoreObserverKeyStoreForTesting(new MeshCoreObserverKeyStore('test-secret', true));
  });

  afterEach(async () => {
    setMeshCoreObserverKeyStoreForTesting(null);
    await harness.db.sources.deleteSource(OBS_A).catch(() => {});
    await harness.db.sources.deleteSource(OBS_B).catch(() => {});
    await harness.cleanup();
  });

  it('limited user granted only on obs-a -> 403 on obs-b (real checkPermissionAsync)', async () => {
    await harness.grant(harness.limited.id, 'configuration', 'write', OBS_A);
    // Deliberately no grant on obs-b.

    const agent = await harness.loginAs(harness.limited);
    const res = await agent.put(`/api/sources/${OBS_B}/observer/key`).send({ privateKey: PRIV });
    expect(res.status).toBe(403);
  });

  it('a key stored on obs-a is invisible from GET on obs-b', async () => {
    await grantReadWrite(harness, harness.limited.id, OBS_A);
    await harness.grant(harness.limited.id, 'configuration', 'read', OBS_B);

    const agent = await harness.loginAs(harness.limited);
    const putRes = await agent.put(`/api/sources/${OBS_A}/observer/key`).send({ privateKey: PRIV });
    expect(putRes.status).toBe(200);
    expect(putRes.body.data.stored).toBe(true);

    const getA = await agent.get(`/api/sources/${OBS_A}/observer/key`);
    expect(getA.body.data.stored).toBe(true);

    const getB = await agent.get(`/api/sources/${OBS_B}/observer/key`);
    expect(getB.status).toBe(200);
    expect(getB.body.data.stored).toBe(false);
  });

  it('admin reaches both sources without explicit grants', async () => {
    const agent = await harness.loginAs(harness.admin);

    const resA = await agent.get(`/api/sources/${OBS_A}/observer/key`);
    expect(resA.status).toBe(200);

    const resB = await agent.get(`/api/sources/${OBS_B}/observer/key`);
    expect(resB.status).toBe(200);
  });

  it('anonymous (no grants) is rejected on all four routes', async () => {
    const agent = await harness.loginAs(null);

    const getRes = await agent.get(`/api/sources/${OBS_A}/observer/key`);
    expect([401, 403]).toContain(getRes.status);

    const putRes = await agent.put(`/api/sources/${OBS_A}/observer/key`).send({ privateKey: PRIV });
    expect([401, 403]).toContain(putRes.status);

    const postRes = await agent.post(`/api/sources/${OBS_A}/observer/key/import`);
    expect([401, 403]).toContain(postRes.status);

    const delRes = await agent.delete(`/api/sources/${OBS_A}/observer/key`);
    expect([401, 403]).toContain(delRes.status);
  });
});
