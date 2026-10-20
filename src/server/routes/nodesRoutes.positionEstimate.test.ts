/**
 * Route tests for GET /api/nodes/:nodeNum/position-estimate (issue #4609).
 *
 * Uses the real route-test harness: real express-session, real auth middleware,
 * and the real singleton :memory: SQLite DB with all migrations applied — so
 * migration 137, the repository, and the permission gate are all genuinely
 * exercised rather than mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

// The router pulls in the source manager registry transitively. Nothing in this
// endpoint talks to a node, so a bare stub keeps the import graph quiet.
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn(() => null),
    getAllManagers: vi.fn(() => []),
    getPrimarySourceId: vi.fn(() => null),
  },
}));

const { default: nodesRouter } = await import('./nodesRoutes.js');
const { default: databaseService } = await import('../../services/database.js');

const NODE_NUM = 0x11223344;
const NODE_ID = '!11223344';
const NOW = 1_700_000_000_000;

async function seedEstimate(overrides: Record<string, unknown> = {}) {
  await databaseService.upsertEstimatedPositionsAsync([{
    nodeNum: NODE_NUM,
    nodeId: NODE_ID,
    latitude: 10,
    longitude: 20,
    uncertaintyKm: 1.25,
    observationCount: 4,
    updatedAt: NOW,
    nEff: 2.4,
    radiusMethod: 'convergence',
    ...overrides,
  }]);
}

async function seedAnchors() {
  await databaseService.replaceEstimatedPositionAnchorsAsync([NODE_NUM], [
    {
      nodeNum: NODE_NUM,
      anchorNodeNum: 0xaaaa0001,
      anchorNodeId: '!aaaa0001',
      anchorLat: 10.05,
      anchorLon: 20,
      kind: 'traceroute',
      snrDb: 6.25,
      observedAt: NOW - 3600_000,
      weight: 0.9,
      createdAt: NOW,
    },
    {
      nodeNum: NODE_NUM,
      anchorNodeNum: 0xbbbb0002,
      anchorNodeId: '!bbbb0002',
      anchorLat: 9.95,
      anchorLon: 20,
      kind: 'neighbor',
      snrDb: null,
      observedAt: NOW - 7200_000,
      weight: 0.4,
      createdAt: NOW,
    },
  ]);
}

async function seedNode(sourceId: string, fields: Record<string, unknown> & { nodeNum: number }) {
  await databaseService.nodes.upsertNode({
    nodeId: `!${fields.nodeNum.toString(16).padStart(8, '0')}`,
    channel: 0,
    lastHeard: Math.floor(NOW / 1000),
    ...fields,
  } as any, sourceId);
}

describe('GET /nodes/:nodeNum/position-estimate', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', nodesRouter) });
    await databaseService.estimatedPositions.deleteAll();
  });

  afterEach(async () => {
    await databaseService.estimatedPositions.deleteAll();
    await databaseService.nodes.deleteAllNodes(harness.sourceA);
    await databaseService.nodes.deleteAllNodes(harness.sourceB);
    await harness.cleanup();
  });

  it('returns the estimate, its derivation, and its anchors', async () => {
    await seedEstimate();
    await seedAnchors();

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/nodes/${NODE_NUM}/position-estimate`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const d = res.body.data;
    expect(d.nodeNum).toBe(NODE_NUM);
    expect(d.nodeId).toBe(NODE_ID);
    expect(d.uncertaintyKm).toBeCloseTo(1.25, 6);
    expect(d.observationCount).toBe(4);
    expect(d.nEff).toBeCloseTo(2.4, 6);
    expect(d.radiusMethod).toBe('convergence');
    // The 5 km lone-anchor heuristic is reported, not hardcoded twice.
    expect(d.singleAnchorDefaultKm).toBe(5);
    expect(d.maxStoredAnchors).toBeGreaterThan(0);

    expect(d.anchors).toHaveLength(2);
    // Strongest contribution first — the anchor that most moved the pin.
    expect(d.anchors[0].anchorNodeId).toBe('!aaaa0001');
    expect(d.anchors[0].kind).toBe('traceroute');
    expect(d.anchors[0].snrDb).toBeCloseTo(6.25, 6);
    expect(d.anchors[0].observedAt).toBe(NOW - 3600_000);
    // distanceKm is derived at request time from the solved point.
    expect(d.anchors[0].distanceKm).toBeGreaterThan(0);

    expect(d.anchors[1].anchorNodeId).toBe('!bbbb0002');
    expect(d.anchors[1].kind).toBe('neighbor');
    // A NeighborInfo pair without SNR must read as absent, not as 0 dB.
    expect(d.anchors[1].snrDb).toBeNull();
  });

  it('accepts a !hex node id as well as a decimal node number', async () => {
    await seedEstimate();
    await seedAnchors();

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/nodes/${NODE_ID}/position-estimate`);

    expect(res.status).toBe(200);
    expect(res.body.data.nodeNum).toBe(NODE_NUM);
  });

  it('404s for a node with no estimated position (the GPS case)', async () => {
    // A node reporting real GPS has no estimated_positions row — the estimator
    // deletes it. So "no rationale for real fixes" falls out of the data model.
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/nodes/${NODE_NUM}/position-estimate`);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('NO_ESTIMATED_POSITION');
  });

  it('flags truncation when more observations fed the estimate than were stored', async () => {
    await seedEstimate({ observationCount: 137 });
    await seedAnchors();

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/nodes/${NODE_NUM}/position-estimate`);

    expect(res.status).toBe(200);
    expect(res.body.data.anchorsStored).toBe(2);
    expect(res.body.data.observationCount).toBe(137);
    expect(res.body.data.anchorsTruncated).toBe(true);
  });

  it('does not flag truncation when every observation was stored', async () => {
    await seedEstimate({ observationCount: 2 });
    await seedAnchors();

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/nodes/${NODE_NUM}/position-estimate`);

    expect(res.body.data.anchorsTruncated).toBe(false);
  });

  it('reports a null derivation for estimates written before #4609', async () => {
    await seedEstimate({ nEff: null, radiusMethod: null });

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/nodes/${NODE_NUM}/position-estimate`);

    expect(res.status).toBe(200);
    // Must stay null so the UI says "unknown" rather than inventing a method.
    expect(res.body.data.nEff).toBeNull();
    expect(res.body.data.radiusMethod).toBeNull();
    expect(res.body.data.anchors).toEqual([]);
  });

  it('rejects a malformed node number', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/nodes/not-a-node/position-estimate');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_NODE_NUM');
  });

  it('requires nodes:read', async () => {
    await seedEstimate();

    const agent = await harness.loginAs(harness.limited);
    const denied = await agent.get(`/nodes/${NODE_NUM}/position-estimate`);
    expect(denied.status).toBe(403);

    // `nodes` is a per-source resource, so the union-across-sources check in
    // checkPermissionAsync is what admits this global endpoint: read on any
    // source is enough to see an estimate pooled from all of them.
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    await seedNode(harness.sourceA, { nodeNum: NODE_NUM, longName: 'Target' });
    const allowed = await agent.get(`/nodes/${NODE_NUM}/position-estimate`);
    expect(allowed.status).toBe(200);
  });

  it('reports the unique anchor count alongside the observation count (#5900)', async () => {
    await seedEstimate({ observationCount: 6, nEff: 1, radiusMethod: 'single_anchor' });
    // Three stored rows, all the same relay at the same coordinates.
    await databaseService.replaceEstimatedPositionAnchorsAsync([NODE_NUM], [0, 1, 2].map((i) => ({
      nodeNum: NODE_NUM,
      anchorNodeNum: 0xaaaa0001,
      anchorNodeId: '!aaaa0001',
      anchorLat: 10.05,
      anchorLon: 20,
      kind: 'traceroute' as const,
      snrDb: -7,
      observedAt: NOW - i * 60_000,
      weight: 0.2 - i * 0.01,
      createdAt: NOW,
    })));

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/nodes/${NODE_NUM}/position-estimate`);

    expect(res.status).toBe(200);
    expect(res.body.data.observationCount).toBe(6);
    expect(res.body.data.uniqueAnchors).toBe(1);
    expect(res.body.data.uniqueAnchorsIsLowerBound).toBe(false);
    expect(res.body.data.radiusMethod).toBe('single_anchor');
  });

  describe('anchor visibility (#5900)', () => {
    // Anchor A lives on source A at its stored coordinates; anchor B lives only
    // on source B. The target node is on source A.
    beforeEach(async () => {
      await seedEstimate();
      await seedAnchors();
      await seedNode(harness.sourceA, { nodeNum: NODE_NUM, longName: 'Target' });
      await seedNode(harness.sourceA, {
        nodeNum: 0xaaaa0001, longName: 'Relay A', shortName: 'RA', latitude: 10.05, longitude: 20,
      });
      await seedNode(harness.sourceB, {
        nodeNum: 0xbbbb0002, longName: 'Relay B', shortName: 'RB', latitude: 9.95, longitude: 20,
      });
    });

    it('shows an admin every anchor, with names', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/nodes/${NODE_NUM}/position-estimate`);

      expect(res.status).toBe(200);
      expect(res.body.data.anchors.map((a: any) => a.anchorNodeId)).toEqual(['!aaaa0001', '!bbbb0002']);
      expect(res.body.data.anchors[0].anchorLongName).toBe('Relay A');
      expect(res.body.data.anchors[1].anchorShortName).toBe('RB');
    });

    it('hides an anchor held only on a source the caller cannot read', async () => {
      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
      await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceA);

      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/nodes/${NODE_NUM}/position-estimate`);

      expect(res.status).toBe(200);
      const d = res.body.data;
      expect(d.anchors.map((a: any) => a.anchorNodeId)).toEqual(['!aaaa0001']);
      expect(d.anchors[0].anchorLongName).toBe('Relay A');
      expect(d.anchorsStored).toBe(1);
      // The list is partial, so the UI must not present it as complete.
      expect(d.anchorsTruncated).toBe(true);
      expect(JSON.stringify(d)).not.toContain('bbbb0002');
      expect(JSON.stringify(d)).not.toContain('Relay B');
    });

    it('hides an anchor the caller cannot view on the map', async () => {
      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
      // No channel_0:viewOnMap on source A.

      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/nodes/${NODE_NUM}/position-estimate`);

      expect(res.status).toBe(200);
      expect(res.body.data.anchors).toEqual([]);
    });

    it('hides an anchor whose visible row carries different coordinates', async () => {
      // The caller can see node bbbb0002 on source A, but not at the position
      // the estimator took from source B.
      await seedNode(harness.sourceA, { nodeNum: 0xbbbb0002, longName: 'Relay B', latitude: 30, longitude: 40 });
      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
      await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceA);

      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/nodes/${NODE_NUM}/position-estimate`);

      expect(res.body.data.anchors.map((a: any) => a.anchorNodeId)).toEqual(['!aaaa0001']);
    });

    it('hides a private position override unless the caller holds nodes_private:read', async () => {
      await seedNode(harness.sourceA, {
        nodeNum: 0xaaaa0001, longName: 'Relay A', latitude: 1, longitude: 2,
        positionOverrideEnabled: true, latitudeOverride: 10.05, longitudeOverride: 20,
        positionOverrideIsPrivate: true,
      });
      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
      await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceA);

      const agent = await harness.loginAs(harness.limited);
      const hidden = await agent.get(`/nodes/${NODE_NUM}/position-estimate`);
      expect(hidden.body.data.anchors).toEqual([]);

      await harness.grant(harness.limited.id, 'nodes_private', 'read', harness.sourceA);
      const shown = await agent.get(`/nodes/${NODE_NUM}/position-estimate`);
      expect(shown.body.data.anchors.map((a: any) => a.anchorNodeId)).toEqual(['!aaaa0001']);
    });

    it('404s when the target node is not on any source the caller can read', async () => {
      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceB);
      await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceB);

      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/nodes/${NODE_NUM}/position-estimate`);

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NO_ESTIMATED_POSITION');
    });
  });
});
