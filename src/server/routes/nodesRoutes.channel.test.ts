/**
 * Route tests for POST /api/nodes/:nodeId/channel (#5923): set or clear a
 * node's channel by hand, and lock it against traffic.
 *
 * Real route-test harness: real session + auth middleware and the singleton
 * :memory: SQLite DB, so the per-source nodes:write gate is exercised.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

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

describe('POST /nodes/:nodeId/channel', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', nodesRouter) });
    await databaseService.nodes.deleteAllNodes();
    await harness.db.nodes.upsertNode(
      { nodeNum: NODE_NUM, nodeId: NODE_ID, longName: 'Rogue', shortName: 'RG', channel: 2 },
      harness.sourceA,
    );
  });

  afterEach(async () => {
    await databaseService.nodes.deleteAllNodes();
    await harness.cleanup();
  });

  const post = async (agent: Awaited<ReturnType<RouteTestHarness['loginAs']>>, body: Record<string, unknown>) =>
    agent.post(`/nodes/${encodeURIComponent(NODE_ID)}/channel`).send(body);

  it('clears the channel, and traffic re-learns it while unlocked', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await post(agent, { sourceId: harness.sourceA, channel: null, locked: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { nodeNum: NODE_NUM, channel: null, locked: false } });
    expect((await harness.db.nodes.getNode(NODE_NUM, harness.sourceA))!.channel).toBeNull();

    await harness.db.nodes.upsertNode({ nodeNum: NODE_NUM, nodeId: NODE_ID, channel: 1 }, harness.sourceA);
    expect((await harness.db.nodes.getNode(NODE_NUM, harness.sourceA))!.channel).toBe(1);
  });

  it('a locked channel survives traffic until unlocked', async () => {
    const agent = await harness.loginAs(harness.admin);
    expect((await post(agent, { sourceId: harness.sourceA, channel: 0, locked: true })).status).toBe(200);

    await harness.db.nodes.upsertNode({ nodeNum: NODE_NUM, nodeId: NODE_ID, channel: 2 }, harness.sourceA);
    let node = await harness.db.nodes.getNode(NODE_NUM, harness.sourceA);
    expect(node!.channel).toBe(0);
    expect(Boolean(node!.channelLocked)).toBe(true);

    // A locked clear also holds.
    expect((await post(agent, { sourceId: harness.sourceA, channel: null, locked: true })).status).toBe(200);
    await harness.db.nodes.upsertNode({ nodeNum: NODE_NUM, nodeId: NODE_ID, channel: 2 }, harness.sourceA);
    expect((await harness.db.nodes.getNode(NODE_NUM, harness.sourceA))!.channel).toBeNull();

    // Unlock: traffic updates it again.
    expect((await post(agent, { sourceId: harness.sourceA, channel: null, locked: false })).status).toBe(200);
    await harness.db.nodes.upsertNode({ nodeNum: NODE_NUM, nodeId: NODE_ID, channel: 2 }, harness.sourceA);
    node = await harness.db.nodes.getNode(NODE_NUM, harness.sourceA);
    expect(node!.channel).toBe(2);
    expect(Boolean(node!.channelLocked)).toBe(false);
  });

  it('needs nodes:write on the named source', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'write', harness.sourceB);
    const agent = await harness.loginAs(harness.limited);
    const denied = await post(agent, { sourceId: harness.sourceA, channel: null, locked: false });
    expect(denied.status).toBe(403);
    expect((await harness.db.nodes.getNode(NODE_NUM, harness.sourceA))!.channel).toBe(2);

    await harness.grant(harness.limited.id, 'nodes', 'write', harness.sourceA);
    const allowed = await post(agent, { sourceId: harness.sourceA, channel: null, locked: false });
    expect(allowed.status).toBe(200);
  });

  it('only changes the named source', async () => {
    await harness.db.nodes.upsertNode(
      { nodeNum: NODE_NUM, nodeId: NODE_ID, longName: 'Rogue', shortName: 'RG', channel: 2 },
      harness.sourceB,
    );
    const agent = await harness.loginAs(harness.admin);
    await post(agent, { sourceId: harness.sourceA, channel: null, locked: true });
    const onB = await harness.db.nodes.getNode(NODE_NUM, harness.sourceB);
    expect(onB!.channel).toBe(2);
    expect(Boolean(onB!.channelLocked)).toBe(false);
  });

  it('rejects bad input and unknown nodes', async () => {
    const agent = await harness.loginAs(harness.admin);
    expect((await post(agent, { sourceId: harness.sourceA, channel: -1, locked: false })).body.code).toBe('INVALID_PARAMETER');
    expect((await post(agent, { sourceId: harness.sourceA, channel: 1.5, locked: false })).body.code).toBe('INVALID_PARAMETER');
    expect((await post(agent, { sourceId: harness.sourceA, channel: '1', locked: false })).body.code).toBe('INVALID_PARAMETER');
    expect((await post(agent, { sourceId: harness.sourceA, channel: 1 })).body.code).toBe('INVALID_PARAMETER_TYPE');
    const missing = await agent.post('/nodes/!deadbeef/channel').send({ sourceId: harness.sourceA, channel: 1, locked: false });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('NODE_NOT_FOUND');
  });
});
