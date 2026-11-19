/**
 * Opt-in reply/tapback count on the per-source unread badge (#5254).
 *
 * `?includeReplies=true` on `/unread-by-source` adds `channelReplies`: unread
 * channel messages whose parent this source's own node sent. It widens what the
 * badge discloses, so each channel passes the `/unread-counts` gates. The bulk
 * clear takes the same flag and must zero the same set.
 *
 * Real harness (session, auth, permission rows), as in
 * `messageRoutes.unreadBySource.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import messageRoutes from './messageRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const LOCAL_A = { nodeNum: 0x0a000001, nodeId: '!0a000001' };
const LOCAL_B = { nodeNum: 0x0b000001, nodeId: '!0b000001' };
const PEER = { nodeNum: 0x0c000002, nodeId: '!0c000002' };
const OTHER = { nodeNum: 0x0c000003, nodeId: '!0c000003' };

const localBySource: Record<string, { nodeNum: number; nodeId: string } | null> = {};
/** Source ids whose manager omits `getAllNodesAsync`. */
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
      if (!omitNodeList.has(sourceId)) manager.getAllNodesAsync = async () => [];
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

describe('unread badge: channel replies & tapbacks (#5254)', () => {
  let harness: RouteTestHarness;
  // Fresh packet ids per test: the harness keeps `read_messages` rows between
  // tests, and on SQLite `message_id` alone is that table's primary key, so a
  // leftover read row would block the next test's mark.
  let base = 0;
  const pid = (n: number) => base + n;

  const seedChannel = async (
    sourceId: string,
    from: { nodeNum: number; nodeId: string },
    packetId: number,
    extra: { replyId?: number; emoji?: number; channel?: number } = {},
  ) => {
    const id = `${sourceId}_${from.nodeNum}_${packetId}`;
    await harness.db.messages.insertMessage(
      {
        id,
        fromNodeNum: from.nodeNum,
        toNodeNum: 0xffffffff,
        fromNodeId: from.nodeId,
        toNodeId: '!ffffffff',
        text: extra.emoji ? '👍' : 'hi',
        channel: extra.channel ?? 0,
        portnum: 1,
        timestamp: Date.now(),
        createdAt: Date.now(),
        replyId: extra.replyId,
        emoji: extra.emoji,
      } as never,
      sourceId,
    );
    return id;
  };

  beforeEach(async () => {
    base += 10_000;
    harness = await createRouteTestApp({ mount: (app) => app.use('/', messageRoutes) });
    localBySource[harness.sourceA] = LOCAL_A;
    localBySource[harness.sourceB] = LOCAL_B;
    for (const n of [LOCAL_A, PEER, OTHER]) {
      await harness.db.nodes.upsertNode(
        { nodeNum: n.nodeNum, nodeId: n.nodeId, channel: 0, lastHeard: Date.now() } as never,
        harness.sourceA,
      );
    }

    // Our own message on A, and someone else's.
    await seedChannel(harness.sourceA, LOCAL_A, pid(500));
    await seedChannel(harness.sourceA, OTHER, pid(600));
    // Counted: a reply and a tapback to our message.
    await seedChannel(harness.sourceA, PEER, pid(501), { replyId: pid(500) });
    await seedChannel(harness.sourceA, PEER, pid(502), { replyId: pid(500), emoji: 1 });
    // Not counted: a reply to someone else's message, and our own reply.
    await seedChannel(harness.sourceA, PEER, pid(601), { replyId: pid(600) });
    await seedChannel(harness.sourceA, LOCAL_A, pid(503), { replyId: pid(500) });
    // Not counted: same packet id on source B, whose own node never sent 500.
    await seedChannel(harness.sourceB, PEER, pid(701), { replyId: pid(500) });
  });

  afterEach(async () => {
    // The harness keeps message rows between tests too.
    await harness.db.messages.deleteAllMessages(harness.sourceA);
    await harness.db.messages.deleteAllMessages(harness.sourceB);
    await harness.cleanup();
    for (const k of Object.keys(localBySource)) delete localBySource[k];
    omitNodeList.clear();
    vi.clearAllMocks();
  });

  it('counts nothing extra unless the caller opts in', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/unread-by-source');
    expect(res.body.sources).toEqual({});
  });

  it('counts replies and tapbacks to the source\'s own messages only', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/unread-by-source?includeReplies=true');
    expect(res.status).toBe(200);
    expect(res.body.sources[harness.sourceA]).toEqual({ directMessages: 0, channelReplies: 2 });
    expect(res.body.sources[harness.sourceB]).toBeUndefined();
  });

  it('stops counting a reply once it has been read', async () => {
    await harness.db.markMessagesAsReadAsync([`${harness.sourceA}_${PEER.nodeNum}_${pid(501)}`], harness.admin.id);
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/unread-by-source?includeReplies=true');
    expect(res.body.sources[harness.sourceA]).toEqual({ directMessages: 0, channelReplies: 1 });
  });

  it('does not count a channel the caller cannot read, even with messages:read', async () => {
    await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/unread-by-source?includeReplies=true');
    expect(res.body.sources[harness.sourceA]).toBeUndefined();
  });

  it('counts the channel once the caller may read it on that source', async () => {
    await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'channel_0', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/unread-by-source?includeReplies=true');
    expect(res.body.sources[harness.sourceA]).toEqual({ directMessages: 0, channelReplies: 2 });
  });

  it('does not count a muted channel', async () => {
    const prefs = await harness.db.notifications.getUserPreferences(harness.admin.id);
    await harness.db.notifications.saveUserPreferences(harness.admin.id, {
      ...(prefs ?? ({} as never)),
      mutedChannels: [{ channelId: 0, muteUntil: null }],
    } as never);
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/unread-by-source?includeReplies=true');
    expect(res.body.sources[harness.sourceA]).toBeUndefined();
  });

  it('still counts replies when the manager cannot list nodes and DMs are pending', async () => {
    // Sender visibility gates DMs only; replies are gated by channel.
    omitNodeList.add(harness.sourceA);
    await harness.db.messages.insertMessage(
      {
        id: `${harness.sourceA}_${PEER.nodeNum}_${pid(900)}`,
        fromNodeNum: PEER.nodeNum, toNodeNum: LOCAL_A.nodeNum,
        fromNodeId: PEER.nodeId, toNodeId: LOCAL_A.nodeId,
        text: 'dm', channel: -1, portnum: 1, timestamp: Date.now(), createdAt: Date.now(),
      } as never,
      harness.sourceA,
    );
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/unread-by-source?includeReplies=true');
    expect(res.body.sources[harness.sourceA]).toEqual({ directMessages: 0, channelReplies: 2 });
  });

  it('mark-all leaves replies alone on a channel the caller cannot read', async () => {
    await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post('/mark-all-dms-read?includeReplies=true');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ marked: 0, sources: 0 });
  });

  it('mark-all clears the replies the badge counted', async () => {
    const agent = await harness.loginAs(harness.admin);
    const cleared = await agent.post('/mark-all-dms-read?includeReplies=true');
    expect(cleared.status).toBe(200);
    expect(cleared.body).toEqual({ marked: 2, sources: 1 });

    const res = await agent.get('/unread-by-source?includeReplies=true');
    expect(res.body.sources[harness.sourceA]).toBeUndefined();
    // The reply to someone else's message was never counted, so stays unread.
    const left = await harness.db.getUnreadCountsByChannelAsync(harness.admin.id, LOCAL_A.nodeId, harness.sourceA);
    expect(left[0]).toBe(2); // OTHER's 600 + PEER's 601
  });
});
