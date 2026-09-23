/**
 * `GET /api/messages/counts` (#5101 WP4) — the Info tab's Total Messages
 * RF/MQTT breakdown. Shares its permission gate with `GET /api/messages` via
 * `resolveMessageReadAccess`, so this suite mirrors the shape of
 * `messageRoutes.listScope.test.ts` / `messageRoutes.unreadCountsScope.test.ts`:
 * real harness (real session, real `optionalAuth`, real `checkPermissionAsync`
 * against seeded rows), not a hand-rolled permission lambda.
 *
 * The harness does not clear `messages` between tests — rows are deleted in
 * `afterEach`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import messageRoutes from './messageRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { PortNum } from '../constants/meshtastic.js';

const LOCAL_A = { nodeNum: 0x0a000001, nodeId: '!0a000001' };
const LOCAL_B = { nodeNum: 0x0b000001, nodeId: '!0b000001' };
const PEER_A = { nodeNum: 0x0a000002, nodeId: '!0a000002' };
const PEER_B = { nodeNum: 0x0b000002, nodeId: '!0b000002' };

describe('GET /api/messages/counts', () => {
  let harness: RouteTestHarness;
  const insertedIds: Array<{ id: string; sourceId: string }> = [];

  const seedMessage = async (
    sourceId: string,
    id: string,
    overrides: Partial<Record<string, unknown>> = {},
  ) => {
    await harness.db.messages.insertMessage(
      {
        id,
        fromNodeNum: PEER_A.nodeNum,
        toNodeNum: LOCAL_A.nodeNum,
        fromNodeId: PEER_A.nodeId,
        toNodeId: LOCAL_A.nodeId,
        text: 'hello',
        channel: 0,
        portnum: PortNum.TEXT_MESSAGE_APP,
        timestamp: Date.now(),
        createdAt: Date.now(),
        ...overrides,
      } as never,
      sourceId,
    );
    insertedIds.push({ id, sourceId });
  };

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/', messageRoutes),
    });
    await harness.db.nodes.upsertNode(
      { nodeNum: LOCAL_A.nodeNum, nodeId: LOCAL_A.nodeId, channel: 0, lastHeard: Date.now() } as never,
      harness.sourceA,
    );
    await harness.db.nodes.upsertNode(
      { nodeNum: PEER_A.nodeNum, nodeId: PEER_A.nodeId, channel: 0, lastHeard: Date.now() } as never,
      harness.sourceA,
    );
    await harness.db.nodes.upsertNode(
      { nodeNum: LOCAL_B.nodeNum, nodeId: LOCAL_B.nodeId, channel: 0, lastHeard: Date.now() } as never,
      harness.sourceB,
    );
    await harness.db.nodes.upsertNode(
      { nodeNum: PEER_B.nodeNum, nodeId: PEER_B.nodeId, channel: 0, lastHeard: Date.now() } as never,
      harness.sourceB,
    );
  });

  afterEach(async () => {
    for (const { id } of insertedIds) {
      await harness.db.messages.deleteMessage(id).catch(() => {});
    }
    insertedIds.length = 0;
    await harness.cleanup();
  });

  it('returns 400 MISSING_SOURCE_ID when sourceId is absent', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/counts');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_SOURCE_ID');
  });

  it('returns 403 when the caller holds no channel, message, or virtual-channel grant', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/counts?sourceId=${harness.sourceA}`);
    expect(res.status).toBe(403);
  });

  it('gives the admin the totals and the rf/mqtt split, wrapped in {success, data}', async () => {
    await seedMessage(harness.sourceA, 'm1', { channel: 0, viaMqtt: false });
    await seedMessage(harness.sourceA, 'm2', { channel: 0, viaMqtt: true });
    await seedMessage(harness.sourceA, 'm3', { channel: -1, portnum: PortNum.TEXT_MESSAGE_APP, viaMqtt: false });

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/counts?sourceId=${harness.sourceA}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.sourceId).toBe(harness.sourceA);
    expect(res.body.data.total).toBe(3);
    expect(res.body.data.byTransport).toEqual({ rf: 2, mqtt: 1 });
  });

  it('excludes TRACEROUTE_APP rows from the total, matching the poll window', async () => {
    await seedMessage(harness.sourceA, 'm1', { channel: 0, viaMqtt: false });
    await seedMessage(harness.sourceA, 'm2', { channel: 0, portnum: PortNum.TRACEROUTE_APP, viaMqtt: false });

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/counts?sourceId=${harness.sourceA}`);

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(1);
  });

  it('a limited user with channel_0:read only does not see channel-1 or DM counts', async () => {
    await seedMessage(harness.sourceA, 'm1', { channel: 0, viaMqtt: false });
    await seedMessage(harness.sourceA, 'm2', { channel: 1, viaMqtt: false });
    await seedMessage(harness.sourceA, 'm3', { channel: -1, viaMqtt: false });

    await harness.grant(harness.limited.id, 'channel_0', 'read', harness.sourceA);

    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/counts?sourceId=${harness.sourceA}`);

    expect(res.status).toBe(200);
    // channel_0:read authorizes ONLY channel 0 (needs the matching channel_N
    // grant too) — channel 1 and the DM are excluded.
    expect(res.body.data.total).toBe(1);
  });

  it('messages:read adds DM counts on top of the channel grant', async () => {
    await seedMessage(harness.sourceA, 'm1', { channel: 0, viaMqtt: false });
    await seedMessage(harness.sourceA, 'm2', { channel: -1, viaMqtt: true });

    await harness.grant(harness.limited.id, 'channel_0', 'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);

    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/counts?sourceId=${harness.sourceA}`);

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(2);
    expect(res.body.data.byTransport).toEqual({ rf: 1, mqtt: 1 });
  });

  it('a grant on sourceB does not authorise sourceA (#3745 class)', async () => {
    await seedMessage(harness.sourceA, 'm1', { channel: 0, viaMqtt: false });

    await harness.grant(harness.limited.id, 'channel_0', 'read', harness.sourceB);
    await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceB);

    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/counts?sourceId=${harness.sourceA}`);

    expect(res.status).toBe(403);
  });
});
