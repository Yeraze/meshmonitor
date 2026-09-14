/**
 * `GET /api/messages/unread-counts` — the permission gate must be scoped to the
 * requested source.
 *
 * The gate used to be un-scoped (`hasPermission(user, 'messages', 'read')` with
 * no source id) while the queries answered for the caller-supplied
 * `?sourceId=`. That is the #3745 cross-source leak in slow motion: holding
 * `messages:read` on ANY one source was enough to read EVERY source's unread DM
 * counts, one request at a time.
 *
 * Found on a live install, not in theory — an account with `messages:read` on
 * three MQTT sources and none on a Meshtastic TCP source could still read that
 * TCP source's DM counts.
 *
 * `/unread-by-source` already re-checks per source id and has its own suite for
 * it; this covers the sibling that named the source instead of enumerating it.
 * Both run through the real harness — real session, real `optionalAuth`, real
 * `checkPermissionAsync` against seeded rows — because a hand-rolled permission
 * lambda cannot catch a regression in the logic it re-implements.
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
        getAllNodesAsync: async (sid?: string) => nodesBySource[sid ?? sourceId] ?? [],
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

describe('unread endpoints — source-scoped permission gate', () => {
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

  it('refuses a source the caller holds no messages grant on, despite a grant elsewhere', async () => {
    // The regression, in the exact permission shape found on the live install:
    // `messages:read` on A only, but `channel_0:viewOnMap` on BOTH.
    //
    // That second grant is what makes this test bite. Sender visibility is
    // filtered separately by `filterNodesByChannelPermission`, so WITHOUT the
    // viewOnMap grant on B the DM would be dropped by that filter regardless
    // and the test would pass against the unfixed code — proving nothing. The
    // leaking account had exactly this combination: it could see B's nodes on
    // the map, and that was enough to turn an un-scoped `messages:read` check
    // into B's unread DM counts.
    await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceA);
    await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceB);

    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/unread-counts?sourceId=${harness.sourceB}`);

    // Either a 403 or an answer with no DM data is acceptable; what must NOT
    // happen is B's counts coming back.
    if (res.status === 200) {
      expect(res.body.directMessages ?? {}).toEqual({});
    } else {
      expect(res.status).toBe(403);
    }
  });

  it('still answers for the source the caller does hold a grant on', async () => {
    // The other half: scoping the gate must not lock a user out of their own
    // source. Without this the fix would read as "working" while breaking the
    // badge for everyone.
    await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceA);

    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/unread-counts?sourceId=${harness.sourceA}`);

    expect(res.status).toBe(200);
    expect(res.body.directMessages).toEqual({ [PEER_A.nodeId]: 1 });
  });

  it('answers for every source for an admin', async () => {
    const agent = await harness.loginAs(harness.admin);

    const a = await agent.get(`/unread-counts?sourceId=${harness.sourceA}`);
    expect(a.status).toBe(200);
    expect(a.body.directMessages).toEqual({ [PEER_A.nodeId]: 1 });

    const b = await agent.get(`/unread-counts?sourceId=${harness.sourceB}`);
    expect(b.status).toBe(200);
    expect(b.body.directMessages).toEqual({ [PEER_B.nodeId]: 1 });
  });

  // `/first-unread` is shaped identically to `/unread-counts` — un-scoped gate,
  // caller-named `?sourceId=`, DMs filtered only by sender visibility — and
  // leaked the same way, returning the oldest-unread timestamp for a source the
  // caller held nothing on. Raised in review on this PR; covered here rather
  // than deferred, so the two cannot drift apart again.
  describe('GET /first-unread', () => {
    it('refuses a source the caller holds no messages grant on', async () => {
      // Same load-bearing `viewOnMap` on B as the sibling case above: without
      // it the sender is dropped by `filterNodesByChannelPermission` and the
      // test would pass against unfixed code.
      await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
      await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceA);
      await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceB);

      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/first-unread?sourceId=${harness.sourceB}`);

      if (res.status === 200) {
        // NOTE the `.data`: unlike `/unread-counts`, this handler returns the
        // `ok()` envelope. Reading `res.body.directMessages` here would be
        // `undefined` and the assertion would pass no matter what the endpoint
        // did — which is exactly how the first draft of this test passed
        // against unfixed code.
        expect(res.body.data?.directMessages ?? {}).toEqual({});
      } else {
        expect(res.status).toBe(403);
      }
    });

    it('still answers for the source the caller does hold a grant on', async () => {
      await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
      await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceA);

      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/first-unread?sourceId=${harness.sourceA}`);

      expect(res.status).toBe(200);
      expect(Object.keys(res.body.data?.directMessages ?? {})).toEqual([PEER_A.nodeId]);
    });
  });
});
