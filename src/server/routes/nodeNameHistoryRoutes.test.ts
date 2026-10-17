/**
 * GET /api/nodes/:nodeId/name-history (#5862) on the route harness: real
 * session + optionalAuth + per-source grants against the harness DB.
 *
 * The answer merges renames from every source the caller may see the node
 * on, and must never include a source they cannot.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import nodeNameHistoryRoutes from './nodeNameHistoryRoutes.js';

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn().mockReturnValue(null),
    getAllManagers: vi.fn().mockReturnValue([]),
  },
}));

const NODE_NUM = 0x9e80e848;
const NODE_ID = '!9e80e848';
const MC_KEY = 'd'.repeat(64);

describe('GET /nodes/:nodeId/name-history (#5862)', () => {
  let harness: RouteTestHarness;

  const rename = (sourceId: string, from: string, to: string, changedAt: number, protocol: 'meshtastic' | 'meshcore' = 'meshtastic') =>
    harness.db.nodeNameHistory.record({
      sourceId,
      protocol,
      nodeKey: protocol === 'meshtastic' ? String(NODE_NUM) : MC_KEY,
      oldLongName: from,
      newLongName: to,
      oldShortName: null,
      newShortName: null,
      changedAt,
    });

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: app => app.use('/', nodeNameHistoryRoutes) });
    for (const sourceId of [harness.sourceA, harness.sourceB]) {
      await harness.db.nodes.upsertNode({ nodeNum: NODE_NUM, nodeId: NODE_ID, longName: 'Bravo', shortName: 'BRV', channel: 0 }, sourceId);
    }
    await harness.db.nodeNameHistory.deleteBySourceId(harness.sourceA);
    await harness.db.nodeNameHistory.deleteBySourceId(harness.sourceB);
  });

  afterEach(async () => {
    await harness.db.nodeNameHistory.deleteBySourceId(harness.sourceA);
    await harness.db.nodeNameHistory.deleteBySourceId(harness.sourceB);
    await harness.db.nodes.deleteNodeRecord(NODE_NUM, harness.sourceA);
    await harness.db.nodes.deleteNodeRecord(NODE_NUM, harness.sourceB);
    await harness.cleanup();
  });

  it('merges the same rename seen on two sources into one entry', async () => {
    await rename(harness.sourceA, 'Alpha', 'Bravo', 1_000_000);
    await rename(harness.sourceB, 'Alpha', 'Bravo', 1_060_000);
    const agent = await harness.loginAs(harness.admin);

    const res = await agent.get(`/nodes/${encodeURIComponent(NODE_ID)}/name-history`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.entries).toHaveLength(1);
    expect(res.body.data.entries[0]).toMatchObject({ oldLongName: 'Alpha', newLongName: 'Bravo', changedAt: 1_000_000 });
    expect(res.body.data.entries[0].sourceIds.sort()).toEqual([harness.sourceA, harness.sourceB].sort());
  });

  it("hides renames from a source where the caller can't see the node", async () => {
    await rename(harness.sourceA, 'Alpha', 'Bravo', 1_000_000);
    await rename(harness.sourceB, 'Secret', 'Bravo', 2_000_000);
    await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);

    const res = await agent.get(`/nodes/${NODE_NUM}/name-history`);

    expect(res.status).toBe(200);
    expect(res.body.data.entries).toEqual([
      expect.objectContaining({ oldLongName: 'Alpha', sourceIds: [harness.sourceA] }),
    ]);
  });

  it('returns nothing to a caller with no grant on any source', async () => {
    await rename(harness.sourceA, 'Alpha', 'Bravo', 1_000_000);
    const agent = await harness.loginAs(harness.limited);

    const res = await agent.get(`/nodes/${NODE_NUM}/name-history`);

    expect(res.status).toBe(200);
    expect(res.body.data.entries).toEqual([]);
  });

  it('MeshCore: scopes to sources the caller holds nodes:read on', async () => {
    await rename(harness.sourceA, 'Hill', 'Ridge', 1_000_000, 'meshcore');
    await rename(harness.sourceB, 'Valley', 'Ridge', 2_000_000, 'meshcore');
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceB);
    const agent = await harness.loginAs(harness.limited);

    const res = await agent.get(`/nodes/${MC_KEY}/name-history`);

    expect(res.status).toBe(200);
    expect(res.body.data.entries).toEqual([
      expect.objectContaining({ oldLongName: 'Valley', newLongName: 'Ridge', sourceIds: [harness.sourceB] }),
    ]);
  });

  it('rejects a malformed node id', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/nodes/not-a-node/name-history');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_NODE_ID');
  });
});
