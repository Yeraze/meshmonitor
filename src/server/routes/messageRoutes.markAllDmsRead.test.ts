/**
 * `POST /api/messages/mark-all-dms-read` — bulk badge clear (#5197).
 *
 * The contract that matters is not "it marks things read", it is that it marks
 * EXACTLY what `GET /unread-by-source` counts. Both go through
 * `collectVisibleUnreadDms`, and these tests pin the two ends of that:
 *
 *   - anything the badge counts must be gone afterwards (otherwise "mark all
 *     read" leaves a badge lit, which is the bug the feature exists to avoid);
 *   - anything the badge does NOT count must survive (a source the caller
 *     cannot read, a sender they cannot see, a muted conversation) — otherwise
 *     the sweep silently clears conversations outside the caller's view.
 *
 * Run through the real harness — real session, real `optionalAuth`, real
 * `checkPermissionAsync` against seeded rows — for the same reason the #5124
 * sibling does: a hand-rolled permission lambda cannot catch a regression in
 * the logic it re-implements.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import messageRoutes from './messageRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const LOCAL_A = { nodeNum: 0x0a000001, nodeId: '!0a000001' };
const LOCAL_B = { nodeNum: 0x0b000001, nodeId: '!0b000001' };
const PEER_A = { nodeNum: 0x0a000002, nodeId: '!0a000002' };
const PEER_B = { nodeNum: 0x0b000002, nodeId: '!0b000002' };

const nodesBySource: Record<string, Array<{ nodeNum: number; user: { id: string }; channel: number }>> = {};
const localBySource: Record<string, { nodeNum: number; nodeId: string } | null> = {};

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn((sourceId: string) => {
      if (!(sourceId in localBySource)) return null;
      return {
        sourceId,
        sourceType: 'meshtastic_tcp',
        getLocalNodeInfo: () => localBySource[sourceId],
        getAllNodesAsync: async () => nodesBySource[sourceId] ?? [],
      };
    }),
    getAllManagers: vi.fn(() => []),
    startManager: vi.fn(),
    stopManager: vi.fn(),
  },
}));

vi.mock('../meshtasticManager.js', () => ({
  MeshtasticManager: vi.fn(),
  fallbackManager: {
    getLocalNodeInfo: () => null,
    getAllNodesAsync: async () => [],
  },
}));

describe('POST /api/messages/mark-all-dms-read (#5197)', () => {
  let harness: RouteTestHarness;

  const seedDm = async (
    sourceId: string,
    from: { nodeNum: number; nodeId: string },
    to: { nodeNum: number; nodeId: string },
    packetId: number,
  ) => {
    await harness.db.messages.insertMessage(
      {
        id: `${sourceId}_${from.nodeNum}_${packetId}`,
        fromNodeNum: from.nodeNum,
        toNodeNum: to.nodeNum,
        fromNodeId: from.nodeId,
        toNodeId: to.nodeId,
        text: 'hello',
        channel: -1,
        portnum: 1,
        timestamp: Date.now(),
        createdAt: Date.now(),
      } as never,
      sourceId,
    );
  };

  const seedNode = async (sourceId: string, n: { nodeNum: number; nodeId: string }) => {
    await harness.db.nodes.upsertNode(
      { nodeNum: n.nodeNum, nodeId: n.nodeId, channel: 0, lastHeard: Date.now() } as never,
      sourceId,
    );
  };

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/', messageRoutes),
    });

    localBySource[harness.sourceA] = LOCAL_A;
    localBySource[harness.sourceB] = LOCAL_B;
    nodesBySource[harness.sourceA] = [
      { nodeNum: PEER_A.nodeNum, user: { id: PEER_A.nodeId }, channel: 0 },
    ];
    nodesBySource[harness.sourceB] = [
      { nodeNum: PEER_B.nodeNum, user: { id: PEER_B.nodeId }, channel: 0 },
    ];

    for (const n of [LOCAL_A, PEER_A]) await seedNode(harness.sourceA, n);
    for (const n of [LOCAL_B, PEER_B]) await seedNode(harness.sourceB, n);

    await seedDm(harness.sourceA, PEER_A, LOCAL_A, 1001);
    await seedDm(harness.sourceB, PEER_B, LOCAL_B, 2001);
  });

  afterEach(async () => {
    await harness.cleanup();
    for (const k of Object.keys(localBySource)) delete localBySource[k];
    for (const k of Object.keys(nodesBySource)) delete nodesBySource[k];
    vi.clearAllMocks();
  });

  it('clears every badge an admin can see, in one request', async () => {
    const agent = await harness.loginAs(harness.admin);

    const before = await agent.get('/unread-by-source');
    expect(before.body.sources[harness.sourceA]).toEqual({ directMessages: 1 });
    expect(before.body.sources[harness.sourceB]).toEqual({ directMessages: 1 });

    const res = await agent.post('/mark-all-dms-read');
    expect(res.status).toBe(200);
    expect(res.body.marked).toBeGreaterThan(0);
    expect(res.body.sources).toBe(2);

    // The actual contract: the badges are gone.
    const after = await agent.get('/unread-by-source');
    expect(after.body.sources).toEqual({});
  });

  it('leaves a source the caller cannot read untouched', async () => {
    // The sweep is bounded by the same per-source gate as the badge. Clearing
    // B here would mark conversations this user is not allowed to see.
    await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceA);

    const limited = await harness.loginAs(harness.limited);
    const res = await limited.post('/mark-all-dms-read');
    expect(res.status).toBe(200);
    expect(res.body.sources).toBe(1);

    // A's badge is cleared for this user...
    const after = await limited.get('/unread-by-source');
    expect(after.body.sources[harness.sourceA]).toBeUndefined();

    // ...and B's DM is still unread, as seen by someone who CAN read it.
    const admin = await harness.loginAs(harness.admin);
    const adminAfter = await admin.get('/unread-by-source');
    expect(adminAfter.body.sources[harness.sourceB]).toEqual({ directMessages: 1 });
  });

  it('does not clear a sender the caller cannot see', async () => {
    // `messages:read` without the channel grant means the badge never counted
    // this DM, so the sweep must not clear it either — otherwise the bulk
    // action reaches further than the view that offered it.
    await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);

    const limited = await harness.loginAs(harness.limited);
    const res = await limited.post('/mark-all-dms-read');
    expect(res.status).toBe(200);
    expect(res.body.sources).toBe(0);
    expect(res.body.marked).toBe(0);

    const admin = await harness.loginAs(harness.admin);
    const adminAfter = await admin.get('/unread-by-source');
    expect(adminAfter.body.sources[harness.sourceA]).toEqual({ directMessages: 1 });
  });

  it('rejects an anonymous caller', async () => {
    // 403, not 401: `optionalAuth` attaches the seeded `anonymous` USER when
    // there is no session, so an anonymous caller is a user without
    // `messages:read` rather than an absent one. The handler's 401 branch is
    // the defensive case for an install with no anonymous row at all.
    const agent = await harness.loginAs(null);
    const res = await agent.post('/mark-all-dms-read');
    expect(res.status).toBe(403);
  });

  it('rejects a signed-in user with no messages:read at all', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post('/mark-all-dms-read');
    expect(res.status).toBe(403);
  });

  it('is idempotent — a second sweep marks nothing and still succeeds', async () => {
    const agent = await harness.loginAs(harness.admin);

    await agent.post('/mark-all-dms-read');
    const second = await agent.post('/mark-all-dms-read');

    expect(second.status).toBe(200);
    expect(second.body.marked).toBe(0);
    expect(second.body.sources).toBe(0);
  });
});
