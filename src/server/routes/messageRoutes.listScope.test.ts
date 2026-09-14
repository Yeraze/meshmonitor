/**
 * `GET /api/messages` and `GET /api/messages/channel/:channel` — the permission
 * gates must be scoped to the requested source.
 *
 * Both handlers checked `messages:read` / `channel_N:read` with NO source id,
 * then answered for the caller-supplied `?sourceId=`. Holding a grant on ANY
 * one source therefore returned another source's message BODIES — not counts,
 * the text itself. #5225 fixed the count-shaped siblings
 * (`/unread-counts`, `/first-unread`); these two are the same class.
 *
 * `GET /` was checked against the live install during that PR and wrongly
 * cleared: a 50-message sample from a busy source is all channel traffic, so
 * the DMs only surface at a higher `?limit=`. At `limit=500` an account with
 * grants on three MQTT sources read a DM's text off a Meshtastic TCP source it
 * held no `messages` grant for. Hence the explicit `limit` in these fixtures —
 * a small sample is exactly what hid the bug.
 *
 * Real harness (real session, real `optionalAuth`, real `checkPermissionAsync`
 * against seeded rows): a hand-rolled permission lambda cannot catch a
 * regression in the logic it re-implements.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import messageRoutes from './messageRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const LOCAL_A = { nodeNum: 0x0a000001, nodeId: '!0a000001' };
const LOCAL_B = { nodeNum: 0x0b000001, nodeId: '!0b000001' };
const PEER_A = { nodeNum: 0x0a000002, nodeId: '!0a000002' };
const PEER_B = { nodeNum: 0x0b000002, nodeId: '!0b000002' };

const localBySource: Record<string, { nodeNum: number; nodeId: string } | null> = {};

/**
 * `GET /` reads through the PRIMARY manager's `getRecentMessages`, not a
 * per-source one, passing the requested sourceId down as a filter — so the fake
 * has to honour that argument rather than return everything.
 */
const recentBySource: Record<string, unknown[]> = {};
const allRecent: unknown[] = [];

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn((sourceId: string) => {
      if (!(sourceId in localBySource)) return null;
      return {
        sourceId,
        sourceType: 'meshtastic_tcp',
        getLocalNodeInfo: () => localBySource[sourceId],
        getAllNodesAsync: async () => [],
        getRecentMessages: async (_limit: number, sid?: string) =>
          sid ? (recentBySource[sid] ?? []) : allRecent,
      };
    }),
    getAllManagers: vi.fn(() => []),
    startManager: vi.fn(),
    stopManager: vi.fn(),
  },
}));

vi.mock('../sourceManagerTypes.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // The route resolves the primary via this helper; hand it a manager whose
    // getRecentMessages honours the sourceId filter.
    getPrimaryMeshtasticManager: () => ({
      getRecentMessages: async (_limit: number, sid?: string) =>
        sid ? (recentBySource[sid] ?? []) : allRecent,
    }),
  };
});

vi.mock('../meshtasticManager.js', () => ({
  MeshtasticManager: vi.fn(),
  fallbackManager: {
    getLocalNodeInfo: () => null,
    getAllNodesAsync: async () => [],
    getRecentMessages: async () => [],
  },
}));

describe('message list endpoints — source-scoped permission gates', () => {
  let harness: RouteTestHarness;

  const mkMsg = (
    sourceId: string,
    from: { nodeNum: number; nodeId: string },
    to: { nodeNum: number; nodeId: string },
    channel: number,
    packetId: number,
    text: string,
  ) => ({
    id: `${sourceId}_${from.nodeNum}_${packetId}`,
    fromNodeNum: from.nodeNum,
    toNodeNum: to.nodeNum,
    fromNodeId: from.nodeId,
    toNodeId: to.nodeId,
    from: from.nodeId,
    to: to.nodeId,
    text,
    channel,
    portnum: 1,
    timestamp: new Date(),
    createdAt: Date.now(),
  });

  const seedChannelMsg = async (
    sourceId: string,
    from: { nodeNum: number; nodeId: string },
    channel: number,
    packetId: number,
    text: string,
  ) => {
    await harness.db.messages.insertMessage(
      {
        id: `${sourceId}_${from.nodeNum}_${packetId}`,
        fromNodeNum: from.nodeNum,
        toNodeNum: 0xffffffff,
        fromNodeId: from.nodeId,
        toNodeId: '!ffffffff',
        text,
        channel,
        portnum: 1,
        timestamp: Date.now(),
        createdAt: Date.now(),
      } as never,
      sourceId,
    );
  };

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/', messageRoutes),
    });

    localBySource[harness.sourceA] = LOCAL_A;
    localBySource[harness.sourceB] = LOCAL_B;

    // One DM per source, addressed to that source's own local node.
    recentBySource[harness.sourceA] = [
      mkMsg(harness.sourceA, PEER_A, LOCAL_A, -1, 1001, 'secret A'),
    ];
    recentBySource[harness.sourceB] = [
      mkMsg(harness.sourceB, PEER_B, LOCAL_B, -1, 2001, 'secret B'),
    ];
    allRecent.length = 0;
    allRecent.push(...recentBySource[harness.sourceA], ...recentBySource[harness.sourceB]);

    // Channel-0 traffic for the /channel/:channel case, which reads the DB.
    await seedChannelMsg(harness.sourceA, PEER_A, 0, 3001, 'channel A');
    await seedChannelMsg(harness.sourceB, PEER_B, 0, 4001, 'channel B');
  });

  afterEach(async () => {
    await harness.cleanup();
    for (const k of Object.keys(localBySource)) delete localBySource[k];
    for (const k of Object.keys(recentBySource)) delete recentBySource[k];
    allRecent.length = 0;
    vi.clearAllMocks();
  });

  describe('GET /', () => {
    it("does not return another source's DM bodies", async () => {
      // The regression, and the one demonstrated on a live install. `limit` is
      // deliberately generous: a small sample is all channel traffic, which is
      // exactly what made this look clean during #5225.
      await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);

      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/?sourceId=${harness.sourceB}&limit=500`);

      if (res.status === 200) {
        const dms = (res.body as Array<{ channel: number; text: string }>).filter(m => m.channel === -1);
        expect(dms).toEqual([]);
        expect(JSON.stringify(res.body)).not.toContain('secret B');
      } else {
        expect(res.status).toBe(403);
      }
    });

    it("still returns the caller's own source's DMs", async () => {
      // The reverse failure: scoping the gate must not blank out the source the
      // caller legitimately holds.
      await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);

      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/?sourceId=${harness.sourceA}&limit=500`);

      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).toContain('secret A');
    });

    it('returns both sources for an admin', async () => {
      const agent = await harness.loginAs(harness.admin);

      const a = await agent.get(`/?sourceId=${harness.sourceA}&limit=500`);
      expect(a.status).toBe(200);
      expect(JSON.stringify(a.body)).toContain('secret A');

      const b = await agent.get(`/?sourceId=${harness.sourceB}&limit=500`);
      expect(b.status).toBe(200);
      expect(JSON.stringify(b.body)).toContain('secret B');
    });
  });

  describe('GET /channel/:channel', () => {
    it("does not return another source's channel messages", async () => {
      await harness.grant(harness.limited.id, 'channel_0', 'read', harness.sourceA);

      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/channel/0?sourceId=${harness.sourceB}&limit=100`);

      if (res.status === 200) {
        expect(JSON.stringify(res.body)).not.toContain('channel B');
      } else {
        expect(res.status).toBe(403);
      }
    });

    it("still returns the caller's own source's channel messages", async () => {
      await harness.grant(harness.limited.id, 'channel_0', 'read', harness.sourceA);

      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/channel/0?sourceId=${harness.sourceA}&limit=100`);

      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).toContain('channel A');
    });

    it('returns both sources for an admin', async () => {
      // Admin takes the `req.user?.isAdmin` short-circuit and never reaches
      // `hasPermission`, so scoping that call cannot affect them — which is
      // precisely why it is worth asserting rather than assuming. Mirrors the
      // `GET /` case above.
      const agent = await harness.loginAs(harness.admin);

      const a = await agent.get(`/channel/0?sourceId=${harness.sourceA}&limit=100`);
      expect(a.status).toBe(200);
      expect(JSON.stringify(a.body)).toContain('channel A');

      const b = await agent.get(`/channel/0?sourceId=${harness.sourceB}&limit=100`);
      expect(b.status).toBe(200);
      expect(JSON.stringify(b.body)).toContain('channel B');
    });
  });
});
