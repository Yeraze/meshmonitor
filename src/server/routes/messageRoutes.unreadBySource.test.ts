/**
 * `GET /api/messages/unread-by-source` — per-source permission isolation (#5124).
 *
 * This endpoint exists to answer one question for EVERY source at once, which
 * makes it the exact shape that leaks if permissions are checked once instead
 * of per source. `/unread-counts` gets away with a single un-scoped
 * `hasPermission(user, 'messages', 'read')` because the caller names one
 * source and sees only that source's numbers; copied across a loop, that same
 * check would hand a user with a grant on source A the unread count for source
 * B. That is the cross-source leak from #3745.
 *
 * So these run through the real harness — real session, real `optionalAuth`,
 * real `checkPermissionAsync` against seeded permission rows — rather than a
 * hand-rolled permission lambda, which by construction cannot catch a
 * regression in the thing it re-implements.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import messageRoutes from './messageRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const LOCAL_A = { nodeNum: 0x0a000001, nodeId: '!0a000001' };
const LOCAL_B = { nodeNum: 0x0b000001, nodeId: '!0b000001' };
const PEER_A = { nodeNum: 0x0a000002, nodeId: '!0a000002' };
const PEER_B = { nodeNum: 0x0b000002, nodeId: '!0b000002' };

/** Node lists the fake managers hand back, keyed by source id. */
const nodesBySource: Record<string, Array<{ nodeNum: number; user: { id: string }; channel: number }>> = {};
/** Local node per source id; `null` models a source that has never connected. */
const localBySource: Record<string, { nodeNum: number; nodeId: string } | null> = {};
/** Source ids whose manager should omit `getAllNodesAsync` entirely. */
const omitNodeList = new Set<string>();

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn((sourceId: string) => {
      if (!(sourceId in localBySource)) return null;
      const manager: Record<string, unknown> = {
        sourceId,
        sourceType: 'meshtastic_tcp',
        getLocalNodeInfo: () => localBySource[sourceId],
      };
      // Some managers (MeshCore, Reticulum) genuinely lack this method.
      if (!omitNodeList.has(sourceId)) {
        manager.getAllNodesAsync = async () => nodesBySource[sourceId] ?? [];
      }
      return manager;
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

describe('GET /api/messages/unread-by-source (#5124)', () => {
  let harness: RouteTestHarness;

  /** Seed one unread DM addressed to `toNodeId` on `sourceId`. */
  const seedDm = async (
    sourceId: string,
    from: { nodeNum: number; nodeId: string },
    to: { nodeNum: number; nodeId: string },
    packetId: number,
  ) => {
    await harness.db.messages.insertMessage(
      {
        // The row-id format is load-bearing elsewhere; keep it honest here too.
        id: `${sourceId}_${from.nodeNum}_${packetId}`,
        fromNodeNum: from.nodeNum,
        toNodeNum: to.nodeNum,
        fromNodeId: from.nodeId,
        toNodeId: to.nodeId,
        text: 'hello',
        // A DM is portnum 1 on the sentinel channel -1 — the same predicate
        // `getBatchUnreadDMCountsAsync` uses.
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

    // One unread DM on each source, addressed to that source's own local node.
    await seedDm(harness.sourceA, PEER_A, LOCAL_A, 1001);
    await seedDm(harness.sourceB, PEER_B, LOCAL_B, 2001);
  });

  afterEach(async () => {
    await harness.cleanup();
    for (const k of Object.keys(localBySource)) delete localBySource[k];
    for (const k of Object.keys(nodesBySource)) delete nodesBySource[k];
    omitNodeList.clear();
    vi.clearAllMocks();
  });

  it('reports only the sources the caller may read', async () => {
    // The whole point of the endpoint. A grant on A must not disclose B.
    await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceA);

    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/unread-by-source');

    expect(res.status).toBe(200);
    expect(res.body.sources[harness.sourceA]).toEqual({ directMessages: 1 });
    // Absent, not zero — and definitely not 1.
    expect(res.body.sources[harness.sourceB]).toBeUndefined();
  });

  it('reports every source for an admin', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/unread-by-source');

    expect(res.status).toBe(200);
    expect(res.body.sources[harness.sourceA]).toEqual({ directMessages: 1 });
    expect(res.body.sources[harness.sourceB]).toEqual({ directMessages: 1 });
  });

  it('reports nothing for a user with no grants at all', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/unread-by-source');

    expect(res.status).toBe(200);
    expect(res.body.sources).toEqual({});
  });

  it('reports nothing to an anonymous caller', async () => {
    // Unread state is per-user (`read_messages.userId`), so there is nothing
    // meaningful to count without an identity.
    const agent = await harness.loginAs(null);
    const res = await agent.get('/unread-by-source');

    expect(res.status).toBe(200);
    expect(res.body.sources).toEqual({});
  });

  it('does not count a sender the caller cannot see', async () => {
    // `messages:read` alone is not enough: the sender still has to survive
    // `filterNodesByChannelPermission`, exactly as in /unread-counts. Without
    // the channel grant the badge must stay dark rather than reveal that
    // *someone* messaged this source.
    await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
    // deliberately no channel_0 viewOnMap grant

    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/unread-by-source');

    expect(res.status).toBe(200);
    expect(res.body.sources[harness.sourceA]).toBeUndefined();
  });

  it('does not fall back to another source\'s local node', async () => {
    // A source still connecting has no local node. Counting anything for it
    // would mean attributing another source's DMs to it.
    localBySource[harness.sourceA] = null;

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/unread-by-source');

    expect(res.body.sources[harness.sourceA]).toBeUndefined();
    expect(res.body.sources[harness.sourceB]).toEqual({ directMessages: 1 });
  });

  it('omits a source whose DMs live outside the messages table', async () => {
    // MeshCore/Reticulum keep messages elsewhere. Reporting 0 would be a lie
    // dressed as a fact; omitting says "not answered here".
    //
    // Recreated rather than updated: `updateSource` accepts only
    // name/config/enabled, because a source's type is immutable once created.
    await harness.db.sources.deleteSource(harness.sourceB);
    await harness.db.sources.createSource({
      id: harness.sourceB,
      name: 'Source B (MeshCore)',
      type: 'meshcore',
      config: {},
      enabled: true,
    });

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/unread-by-source');

    expect(res.body.sources[harness.sourceA]).toEqual({ directMessages: 1 });
    expect(res.body.sources[harness.sourceB]).toBeUndefined();
  });

  it('stops counting a DM once it has been read', async () => {
    const agent = await harness.loginAs(harness.admin);
    expect((await agent.get('/unread-by-source')).body.sources[harness.sourceA])
      .toEqual({ directMessages: 1 });

    await harness.db.markMessagesAsReadAsync(
      [`${harness.sourceA}_${PEER_A.nodeNum}_1001`],
      harness.admin.id,
    );

    expect((await agent.get('/unread-by-source')).body.sources[harness.sourceA])
      .toBeUndefined();
  });

  it('does not count a muted sender', async () => {
    // Matches /unread-counts: muting a DM conversation silences its badge too.
    // Without this the mute would quiet notifications but leave the source card
    // permanently lit, which is the opposite of what muting is for.
    const prefs = await harness.db.notifications.getUserPreferences(harness.admin.id);
    await harness.db.notifications.saveUserPreferences(harness.admin.id, {
      ...(prefs ?? ({} as never)),
      mutedDMs: [{ nodeUuid: PEER_A.nodeId, muteUntil: null }],
    } as never);

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/unread-by-source');

    expect(res.body.sources[harness.sourceA]).toBeUndefined();
    // The other source is untouched — muting is per-conversation, not global.
    expect(res.body.sources[harness.sourceB]).toEqual({ directMessages: 1 });
  });

  it('counts nothing for a manager that cannot list its nodes', async () => {
    // The node list IS the sender-visibility gate, so a manager without
    // `getAllNodesAsync` must fail CLOSED. Failing open would hand out counts
    // with no permission filtering at all.
    omitNodeList.add(harness.sourceA);

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/unread-by-source');

    expect(res.body.sources[harness.sourceA]).toBeUndefined();
    // The source that CAN list its nodes is unaffected — proving the omission
    // is what silenced A, not a blanket failure of the handler.
    expect(res.body.sources[harness.sourceB]).toEqual({ directMessages: 1 });
  });
});
