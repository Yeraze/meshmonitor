/**
 * Purge non-favourite MeshCore nodes (#6041) — real session + real permission
 * checks via the route harness. Covers: non-favourites deleted, favourites
 * (isFavorite / device flags & 0x01) kept, per-source isolation, the
 * nodes:write gate, and the count preview.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import contactsRoutes from './meshcoreContactsRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';

const base = (sourceId: string) => `/api/sources/${sourceId}/meshcore`;

// Distinct 64-hex public keys.
const key = (n: number) => n.toString(16).padStart(2, '0').repeat(32);

describe('meshcoreContactsRoutes — purge non-favourite nodes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/api/sources/:id/meshcore', contactsRoutes),
    });

    // sourceA: one favourite, two non-favourites.
    await databaseService.meshcore.upsertNode({ publicKey: key(1), advName: 'Fav A' }, harness.sourceA);
    await databaseService.meshcore.setNodeFavorite(harness.sourceA, key(1), true);
    await databaseService.meshcore.upsertNode({ publicKey: key(2), advName: 'Plain A1' }, harness.sourceA);
    await databaseService.meshcore.upsertNode({ publicKey: key(3), advName: 'Plain A2' }, harness.sourceA);

    // sourceB: one non-favourite that must never be touched.
    await databaseService.meshcore.upsertNode({ publicKey: key(4), advName: 'Plain B' }, harness.sourceB);
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  const keysFor = async (sourceId: string): Promise<string[]> =>
    (await databaseService.meshcore.getNodesBySource(sourceId)).map((n) => n.publicKey).sort();

  it('preview counts only the non-favourite nodes for the source', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`${base(harness.sourceA)}/nodes/purge-non-favourites/preview`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { count: 2 } });

    const resB = await agent.get(`${base(harness.sourceB)}/nodes/purge-non-favourites/preview`);
    expect(resB.body.data.count).toBe(1);
  });

  it('deletes non-favourites, keeps the favourite, and leaves other sources alone', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(`${base(harness.sourceA)}/nodes/purge-non-favourites`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { deleted: 2 } });

    // Only the favourite survives on sourceA.
    expect(await keysFor(harness.sourceA)).toEqual([key(1)]);
    // sourceB untouched.
    expect(await keysFor(harness.sourceB)).toEqual([key(4)]);
  });

  it('is idempotent — a second purge deletes nothing', async () => {
    const agent = await harness.loginAs(harness.admin);
    await agent.post(`${base(harness.sourceA)}/nodes/purge-non-favourites`).expect(200);
    const second = await agent.post(`${base(harness.sourceA)}/nodes/purge-non-favourites`);
    expect(second.body).toEqual({ success: true, data: { deleted: 0 } });
  });

  it('requires nodes:write — nodes:read alone is refused', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.get(`${base(harness.sourceA)}/nodes/purge-non-favourites/preview`)).status).toBe(403);
    expect((await agent.post(`${base(harness.sourceA)}/nodes/purge-non-favourites`)).status).toBe(403);
    // Nothing was deleted.
    expect(await keysFor(harness.sourceA)).toEqual([key(1), key(2), key(3)].sort());
  });

  it('nodes:write on one source does not authorise another', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.post(`${base(harness.sourceA)}/nodes/purge-non-favourites`)).status).toBe(200);
    expect((await agent.post(`${base(harness.sourceB)}/nodes/purge-non-favourites`)).status).toBe(403);
    // sourceB kept its node.
    expect(await keysFor(harness.sourceB)).toEqual([key(4)]);
  });

  it('an anonymous caller cannot purge', async () => {
    const agent = await harness.loginAs(null);
    const res = await agent.post(`${base(harness.sourceA)}/nodes/purge-non-favourites`);
    expect([401, 403]).toContain(res.status);
  });
});
