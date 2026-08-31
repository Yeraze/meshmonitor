/**
 * Route tests for GET /api/nodes/:nodeNum/sources.
 *
 * Uses the real route-test harness: real express-session, real auth
 * middleware, and the real singleton :memory: SQLite DB — so the
 * `nodes:read` gate + the repository query are genuinely exercised.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

// The router pulls in the source manager registry transitively. Nothing in
// this endpoint talks to a node, so a bare stub keeps the import graph quiet.
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

describe('GET /nodes/:nodeNum/sources', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', nodesRouter) });
    // Real singleton DB persists between tests; clear the nodes table so each
    // case starts from a known-empty state.
    await databaseService.nodes.deleteAllNodes();
  });

  afterEach(async () => {
    await databaseService.nodes.deleteAllNodes();
    await harness.cleanup();
  });

  it('returns every source the node has a row on, with per-source names', async () => {
    await harness.db.nodes.upsertNode(
      { nodeNum: NODE_NUM, nodeId: NODE_ID, longName: 'Alpha on A', shortName: 'A1' },
      harness.sourceA,
    );
    await harness.db.nodes.upsertNode(
      { nodeNum: NODE_NUM, nodeId: NODE_ID, longName: 'Alpha on B', shortName: 'A2' },
      harness.sourceB,
    );

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/nodes/${NODE_NUM}/sources`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const rows = res.body.data.sources as Array<{ sourceId: string; sourceName: string; nodeName: string }>;
    expect(rows).toHaveLength(2);
    const bySid = new Map(rows.map((r) => [r.sourceId, r]));
    expect(bySid.get(harness.sourceA)?.nodeName).toBe('Alpha on A');
    expect(bySid.get(harness.sourceB)?.nodeName).toBe('Alpha on B');
    // sourceName is populated (from the sources table).
    for (const r of rows) expect(typeof r.sourceName).toBe('string');
  });

  it('accepts a !hex node id as well as a decimal node number', async () => {
    await harness.db.nodes.upsertNode(
      { nodeNum: NODE_NUM, nodeId: NODE_ID, longName: 'Alpha', shortName: 'A' },
      harness.sourceA,
    );

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/nodes/${encodeURIComponent(NODE_ID)}/sources`);

    expect(res.status).toBe(200);
    expect(res.body.data.sources).toHaveLength(1);
    expect(res.body.data.sources[0].sourceId).toBe(harness.sourceA);
  });

  it('returns an empty list when the node is not on any source', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/nodes/${NODE_NUM}/sources`);

    expect(res.status).toBe(200);
    expect(res.body.data.sources).toEqual([]);
  });

  it('400s on a malformed nodeNum', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/nodes/notanumber/sources');

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('INVALID_NODE_NUM');
  });

  it('rejects a caller without nodes:read (401 for anonymous)', async () => {
    // The harness seeds an anonymous "public" user without any nodes:read
    // grants; the requirePermission gate must reject them.
    const agent = await harness.loginAs(null);
    const res = await agent.get(`/nodes/${NODE_NUM}/sources`);

    // Anonymous → 401 from optionalAuth+requirePermission chain; a logged-in
    // user without the grant would be 403. Either way, not 200.
    expect(res.status).not.toBe(200);
  });

  it('falls back to shortName in the nodeName when longName is missing', async () => {
    await harness.db.nodes.upsertNode(
      { nodeNum: NODE_NUM, nodeId: NODE_ID, longName: null, shortName: 'SHRT' },
      harness.sourceA,
    );

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/nodes/${NODE_NUM}/sources`);

    expect(res.status).toBe(200);
    expect(res.body.data.sources[0].nodeName).toBe('SHRT');
  });
});
