/**
 * `GET /api/messages/unread-counts` and `/unread-by-source` — mutes are read
 * per source (#5487), through the real route harness.
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

const BROADCAST = { nodeNum: 0xffffffff, nodeId: '!ffffffff' };

const basePrefs = {
  enableWebPush: true,
  enableApprise: false,
  enabledChannels: [],
  enableDirectMessages: true,
  notifyOnEmoji: true,
  notifyOnMqtt: true,
  notifyOnNewNode: true,
  notifyOnTraceroute: true,
  notifyOnInactiveNode: false,
  notifyOnLowBattery: false,
  lowBatteryThreshold: 20,
  lowBatteryVoltageThreshold: 3300,
  notifyOnServerEvents: false,
  notifyOnWaypoint: false,
  waypointRadiusKm: 10,
  waypointCenterLat: null,
  waypointCenterLon: null,
  prefixWithNodeName: false,
  monitoredNodes: [],
  whitelist: [],
  blacklist: [],
  appriseUrls: [],
  mutedChannels: [] as Array<{ channelId: number; muteUntil: number | null }>,
  mutedDMs: [] as Array<{ nodeUuid: string; muteUntil: number | null }>,
};

/**
 * #5487: the unread routes must read mutes from the SAME row push/Apprise
 * filtering reads — the per-source row, falling back to '' only when the
 * source has none. They used to read the '' row unconditionally.
 */
describe('unread endpoints — per-source mutes (#5487)', () => {
  let harness: RouteTestHarness;

  const seedMessage = async (
    sourceId: string,
    from: { nodeNum: number; nodeId: string },
    to: { nodeNum: number; nodeId: string },
    channel: number,
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
        channel,
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

  const savePrefs = (sourceId: string, patch: Partial<typeof basePrefs>) =>
    harness.db.notifications.saveUserPreferences(harness.admin.id, { ...basePrefs, ...patch } as never, sourceId);

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/', messageRoutes),
    });

    localBySource[harness.sourceA] = LOCAL_A;
    localBySource[harness.sourceB] = LOCAL_B;
    nodesBySource[harness.sourceA] = [{ nodeNum: PEER_A.nodeNum, user: { id: PEER_A.nodeId }, channel: 0 }];
    nodesBySource[harness.sourceB] = [{ nodeNum: PEER_B.nodeNum, user: { id: PEER_B.nodeId }, channel: 0 }];

    for (const n of [LOCAL_A, PEER_A]) await seedNode(harness.sourceA, n);
    for (const n of [LOCAL_B, PEER_B]) await seedNode(harness.sourceB, n);

    await seedMessage(harness.sourceA, PEER_A, LOCAL_A, -1, 1001);
    await seedMessage(harness.sourceB, PEER_B, LOCAL_B, -1, 2001);
    await seedMessage(harness.sourceA, PEER_A, BROADCAST, 2, 1002);
    await seedMessage(harness.sourceB, PEER_B, BROADCAST, 2, 2002);
  });

  afterEach(async () => {
    await harness.cleanup();
    for (const k of Object.keys(localBySource)) delete localBySource[k];
    for (const k of Object.keys(nodesBySource)) delete nodesBySource[k];
    vi.clearAllMocks();
  });

  it('/unread-counts honours the per-source row, not the \'\' row', async () => {
    // '' row mutes nothing; source A's own row mutes channel 2 and PEER_A.
    await savePrefs('', {});
    await savePrefs(harness.sourceA, {
      mutedChannels: [{ channelId: 2, muteUntil: null }],
      mutedDMs: [{ nodeUuid: PEER_A.nodeId, muteUntil: null }],
    });

    const agent = await harness.loginAs(harness.admin);
    const a = await agent.get(`/unread-counts?sourceId=${harness.sourceA}`);
    expect(a.status).toBe(200);
    expect(a.body.channels?.[2]).toBeUndefined();
    expect(a.body.directMessages).toEqual({});

    // Source B has no row of its own → falls back to the '' row (no mutes).
    const b = await agent.get(`/unread-counts?sourceId=${harness.sourceB}`);
    expect(b.status).toBe(200);
    expect(b.body.channels?.[2]).toBe(1);
    expect(b.body.directMessages).toEqual({ [PEER_B.nodeId]: 1 });
  });

  it('/unread-counts ignores a \'\' row mute once the source has its own row', async () => {
    await savePrefs('', { mutedChannels: [{ channelId: 2, muteUntil: null }] });
    await savePrefs(harness.sourceA, {});

    const agent = await harness.loginAs(harness.admin);
    const a = await agent.get(`/unread-counts?sourceId=${harness.sourceA}`);
    expect(a.body.channels?.[2]).toBe(1);

    // B has no row → the '' mute still applies there.
    const b = await agent.get(`/unread-counts?sourceId=${harness.sourceB}`);
    expect(b.body.channels?.[2]).toBeUndefined();
  });

  it('/unread-by-source reads each source\'s own row', async () => {
    await savePrefs(harness.sourceA, { mutedDMs: [{ nodeUuid: PEER_A.nodeId, muteUntil: null }] });
    await savePrefs(harness.sourceB, {});

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/unread-by-source');
    expect(res.status).toBe(200);
    expect(res.body.sources[harness.sourceA]).toBeUndefined();
    expect(res.body.sources[harness.sourceB]).toEqual({ directMessages: 1 });
  });

  it('an expired per-source mute does not hide the badge', async () => {
    await savePrefs(harness.sourceA, { mutedChannels: [{ channelId: 2, muteUntil: Date.now() - 1000 }] });
    const agent = await harness.loginAs(harness.admin);
    const a = await agent.get(`/unread-counts?sourceId=${harness.sourceA}`);
    expect(a.body.channels?.[2]).toBe(1);
  });
});
