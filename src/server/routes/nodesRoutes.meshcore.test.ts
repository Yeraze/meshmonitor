/**
 * GET /api/nodes — the MeshCore rows it appends (#5632).
 *
 * Real route-test harness: real session, real auth middleware and the real
 * `:memory:` database, so the per-source `nodes:read` / `nodes:viewOnMap`
 * grants are checked by real SQL. Only the registry is a stand-in, holding one
 * MeshCore manager per harness source.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const KEY_POS = 'a1'.repeat(32);
const KEY_NOPOS = 'b2'.repeat(32);
const KEY_B = 'c3'.repeat(32);

const managers: Array<{ sourceId: string; sourceType: string; getAllNodes: () => Promise<unknown[]> }> = [];

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn((id: string) => managers.find((m) => m.sourceId === id) ?? null),
    getAllManagers: vi.fn(() => managers),
    getPrimarySourceId: vi.fn(() => null),
    getPrimaryMeshtasticSourceId: vi.fn(() => null),
  },
}));

const { default: nodesRouter } = await import('./nodesRoutes.js');
const { default: databaseService } = await import('../../services/database.js');

/** One `nodes` permission row: `harness.grant` writes a single action per row,
 *  and a (user, resource, source) pair holds only one row. */
async function grantNodes(userId: number, sourceId: string, actions: { read?: boolean; viewOnMap?: boolean }): Promise<void> {
  await databaseService.auth.createPermission({
    userId,
    resource: 'nodes',
    canRead: actions.read === true,
    canWrite: false,
    canViewOnMap: actions.viewOnMap === true,
    sourceId,
    grantedAt: Date.now(),
    grantedBy: null,
  });
}

interface McRow {
  nodeId: string;
  sourceId: string;
  isMeshCore?: boolean;
  longName?: string;
  latitude?: number;
  position?: { latitude: number; longitude: number };
}

const meshcoreRows = (body: unknown): McRow[] => (body as McRow[]).filter((n) => n.isMeshCore);

describe('GET /nodes — MeshCore rows (#5632)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', nodesRouter) });
    managers.length = 0;
    managers.push(
      {
        sourceId: harness.sourceA,
        sourceType: 'meshcore',
        getAllNodes: async () => [
          { publicKey: KEY_POS, name: 'With Fix', advType: 2, latitude: 45.5, longitude: -122.5, lastHeard: Date.now() },
          { publicKey: KEY_NOPOS, name: 'Advert Only', advType: 1, lastHeard: Date.now() },
        ],
      },
      {
        sourceId: harness.sourceB,
        sourceType: 'meshcore',
        getAllNodes: async () => [
          { publicKey: KEY_B, name: 'Other Source', advType: 2, latitude: 10, longitude: 20, lastHeard: Date.now() },
        ],
      },
    );
  });

  afterEach(async () => {
    managers.length = 0;
    await harness.cleanup();
  });

  it('gives an admin the positioned rows of every source, and no position-less ones by default', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/nodes');
    expect(res.status).toBe(200);
    const rows = meshcoreRows(res.body);
    expect(rows.map((r) => r.longName).sort()).toEqual(['Other Source', 'With Fix']);
    expect(rows.every((r) => typeof r.position?.latitude === 'number')).toBe(true);
  });

  it('includeAllMeshcore=true adds the position-less rows, without a position object', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/nodes?sourceId=${harness.sourceA}&includeAllMeshcore=true`);
    const rows = meshcoreRows(res.body);
    expect(rows.map((r) => r.longName).sort()).toEqual(['Advert Only', 'With Fix']);
    const advertOnly = rows.find((r) => r.longName === 'Advert Only')!;
    expect(advertOnly.position).toBeUndefined();
    expect(advertOnly.latitude).toBeUndefined();
  });

  it('scopes to the requested source', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/nodes?sourceId=${harness.sourceA}`);
    const rows = meshcoreRows(res.body);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.sourceId === harness.sourceA)).toBe(true);
    // The id carries the source, so a same-key node elsewhere is another row.
    expect(rows[0].nodeId.startsWith(`mc:${harness.sourceA}:`)).toBe(true);
  });

  it('gives an anonymous caller no MeshCore rows', async () => {
    const agent = await harness.loginAs(null);
    const res = await agent.get('/nodes?includeAllMeshcore=true');
    expect(res.status).toBe(200);
    expect(meshcoreRows(res.body)).toEqual([]);
  });

  it('gives a user with no grant on a source none of its rows', async () => {
    await grantNodes(harness.limited.id, harness.sourceA, { read: true, viewOnMap: true });
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/nodes?includeAllMeshcore=true');
    const rows = meshcoreRows(res.body);
    expect(rows.map((r) => r.longName).sort()).toEqual(['Advert Only', 'With Fix']);
    expect(rows.every((r) => r.sourceId === harness.sourceA)).toBe(true);
  });

  it('nodes:read without nodes:viewOnMap lists the rows but never their positions', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);

    const all = meshcoreRows((await agent.get('/nodes?includeAllMeshcore=true')).body);
    expect(all.map((r) => r.longName).sort()).toEqual(['Advert Only', 'With Fix']);
    for (const r of all) {
      expect(r.position).toBeUndefined();
      expect(r.latitude).toBeUndefined();
    }
    // The default (map) view shows positioned rows only, so with the position
    // masked there is nothing to return.
    expect(meshcoreRows((await agent.get('/nodes')).body)).toEqual([]);
  });

  it('nodes:viewOnMap without nodes:read shows positioned rows only, even with includeAllMeshcore', async () => {
    await grantNodes(harness.limited.id, harness.sourceA, { viewOnMap: true });
    const agent = await harness.loginAs(harness.limited);
    const rows = meshcoreRows((await agent.get('/nodes?includeAllMeshcore=true')).body);
    expect(rows.map((r) => r.longName)).toEqual(['With Fix']);
    expect(rows[0].position).toEqual({ latitude: 45.5, longitude: -122.5 });
  });

  it('a grant on one source never shows a same-key node held by another', async () => {
    // Source B now holds the SAME public key as source A's positioned node.
    managers[1].getAllNodes = async () => [
      { publicKey: KEY_POS, name: 'Same Key On B', advType: 2, latitude: 1, longitude: 2, lastHeard: Date.now() },
    ];
    await grantNodes(harness.limited.id, harness.sourceA, { read: true, viewOnMap: true });
    const agent = await harness.loginAs(harness.limited);
    const rows = meshcoreRows((await agent.get('/nodes?includeAllMeshcore=true')).body);
    expect(rows.some((r) => r.longName === 'Same Key On B')).toBe(false);
    expect(rows.find((r) => r.longName === 'With Fix')?.nodeId).toBe(`mc:${harness.sourceA}:${KEY_POS.substring(0, 12)}`);

    // An admin sees both, as two rows with different ids.
    const adminRows = meshcoreRows((await (await harness.loginAs(harness.admin)).get('/nodes')).body);
    const sameKey = adminRows.filter((r) => r.nodeId.endsWith(KEY_POS.substring(0, 12)));
    expect(new Set(sameKey.map((r) => r.nodeId)).size).toBe(2);
  });
});
