/**
 * The unread DM sender gate on GET /api/messages/unread-counts and
 * /first-unread reads only the DM senders it is asked about
 * (`nodes.getNodeChannelsByNodeIds`) instead of every node on the source.
 *
 * These tests hold the new lookup to the OLD answer: `legacyVisibleSenders`
 * below is the previous `visibleDmSenders` body (every node on the source via
 * `getAllNodesAsync`, filtered by `canViewNode`), run against the same DB, and
 * each case compares the route's DM keys to it, across admin, partial-grant
 * and cross-source permission shapes. A few cases also pin the expected ids
 * directly, so the two cannot agree on a wrong answer unnoticed.
 *
 * Real session, auth middleware and permission rows via createRouteTestApp.
 * The unread queries are stubbed to fixed answers; the managers are fakes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import databaseService from '../../services/database.js';
import messageRoutes from './messageRoutes.js';
import { createRouteTestApp, type RouteTestHarness, type SeededUser } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';
import { loadAllNodesAsDeviceInfo } from '../utils/dbNodeMapper.js';
import { loadNodeViewAccess } from '../utils/nodeEnhancer.js';
import { CHANNEL_DB_OFFSET } from '../constants/meshtastic.js';

const idOf = (n: number) => `!${n.toString(16).padStart(8, '0')}`;

const PEER = 0x0000aa01; // channel 0 on A; channel 3 on B
const HIDDEN = 0x0000aa02; // channel 3 on A
const NOCHAN = 0x0000aa03; // no channel on A (reads as 0)
const VIRT = 0x0000aa04; // a channel-database channel on A
const B_ONLY = 0x0000aa05; // a row on B only
const NO_NODE = 0x0000aa06; // a DM sender with no node row anywhere

const SENDERS = [PEER, HIDDEN, NOCHAN, VIRT, B_ONLY, NO_NODE].map(idOf);
const DM_COUNTS: Record<string, number> = Object.fromEntries(SENDERS.map((id, i) => [id, i + 1]));
const DM_FIRST: Record<string, number> = Object.fromEntries(SENDERS.map((id, i) => [id, 1000 * (i + 1)]));

describe('unread DM sender lookup matches the whole-source load', () => {
  let harness: RouteTestHarness;
  const getAllNodesAsync = vi.fn((id?: string) => loadAllNodesAsDeviceInfo(id));

  const fakeManager = (sourceId: string, localNum: number): ISourceManager =>
    ({
      sourceId,
      sourceType: 'meshtastic_tcp',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue({ sourceId, sourceType: 'meshtastic_tcp', connected: true }),
      getLocalNodeInfo: vi.fn().mockReturnValue({ nodeNum: localNum, nodeId: idOf(localNum) }),
      getAllNodesAsync,
    }) as unknown as ISourceManager;

  const give = async (resource: string, actions: Array<'read' | 'viewOnMap'>, sourceId: string): Promise<void> => {
    await databaseService.auth.createPermission({
      userId: harness.limited.id,
      resource,
      canRead: actions.includes('read'),
      canWrite: false,
      canViewOnMap: actions.includes('viewOnMap'),
      sourceId,
      grantedAt: Date.now(),
      grantedBy: null,
    } as never);
  };

  const node = (nodeNum: number, channel: number | undefined, sourceId: string) =>
    databaseService.nodes.upsertNode(
      { nodeNum, nodeId: idOf(nodeNum), longName: `n${nodeNum}`, shortName: 'N', ...(channel === undefined ? {} : { channel }) },
      sourceId,
    );

  /** The previous `visibleDmSenders`, verbatim apart from its inputs. */
  const legacyVisibleSenders = async (user: SeededUser, sourceId: string | undefined): Promise<Set<string>> => {
    const access = await loadNodeViewAccess(user as never);
    const allNodes = await loadAllNodesAsDeviceInfo(sourceId);
    const visible = user.isAdmin
      ? allNodes
      : allNodes.filter((n) => access.canViewNode(sourceId, (n as { channel?: number }).channel));
    return new Set(visible.map((n) => n.user?.id).filter((id): id is string => typeof id === 'string'));
  };

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/api/messages', messageRoutes) });
    await sourceManagerRegistry.addManager(fakeManager(harness.sourceA, 0x000003e7));
    await sourceManagerRegistry.addManager(fakeManager(harness.sourceB, 0x000003e8));

    await node(PEER, 0, harness.sourceA);
    await node(HIDDEN, 3, harness.sourceA);
    await node(NOCHAN, undefined, harness.sourceA);
    await node(VIRT, CHANNEL_DB_OFFSET + 7, harness.sourceA);
    await node(PEER, 3, harness.sourceB);
    await node(B_ONLY, 0, harness.sourceB);

    vi.spyOn(databaseService, 'getBatchUnreadDMCountsAsync').mockResolvedValue({ ...DM_COUNTS });
    vi.spyOn(databaseService, 'getUnreadCountsByChannelAsync').mockResolvedValue({ 0: 1 });
    vi.spyOn(databaseService, 'getFirstUnreadTimestampsAsync').mockResolvedValue({
      channels: { 0: 500 },
      directMessages: { ...DM_FIRST },
    });
    getAllNodesAsync.mockClear();
  });

  afterEach(async () => {
    await sourceManagerRegistry.removeManager(harness.sourceA);
    await sourceManagerRegistry.removeManager(harness.sourceB);
    vi.restoreAllMocks();
    await harness.cleanup();
  });

  const read = async (user: SeededUser, sourceId: string | undefined) => {
    const agent = await harness.loginAs(user);
    const q = sourceId ? { sourceId } : {};
    const counts = await agent.get('/api/messages/unread-counts').query(q);
    const first = await agent.get('/api/messages/first-unread').query(q);
    expect(counts.status).toBe(200);
    expect(first.status).toBe(200);
    return {
      counts: counts.body.directMessages as Record<string, number>,
      first: first.body.data.directMessages as Record<string, number>,
    };
  };

  /** Route output for one source must equal the old whole-source filter. */
  const expectMatchesLegacy = async (user: SeededUser, sourceId: string | undefined): Promise<string[]> => {
    const legacy = await legacyVisibleSenders(user, sourceId);
    const { counts, first } = await read(user, sourceId);
    const expectedCounts = Object.fromEntries(Object.entries(DM_COUNTS).filter(([id]) => legacy.has(id)));
    const expectedFirst = Object.fromEntries(Object.entries(DM_FIRST).filter(([id]) => legacy.has(id)));
    expect(counts).toEqual(expectedCounts);
    expect(first).toEqual(expectedFirst);
    // The whole-source load is gone from these routes.
    expect(getAllNodesAsync).not.toHaveBeenCalled();
    return Object.keys(counts).sort();
  };

  it('admin, one source: every sender with a node row on that source', async () => {
    const ids = await expectMatchesLegacy(harness.admin, harness.sourceA);
    expect(ids).toEqual([PEER, HIDDEN, NOCHAN, VIRT].map(idOf).sort());
  });

  it('admin, every source: senders with a node row on any source', async () => {
    const ids = await expectMatchesLegacy(harness.admin, undefined);
    expect(ids).toEqual([PEER, HIDDEN, NOCHAN, VIRT, B_ONLY].map(idOf).sort());
  });

  it('limited, channel_0 viewOnMap on the source: channel-0 and channel-less senders only', async () => {
    await give('messages', ['read'], harness.sourceA);
    await give('channel_0', ['viewOnMap'], harness.sourceA);
    const ids = await expectMatchesLegacy(harness.limited, harness.sourceA);
    expect(ids).toEqual([PEER, NOCHAN].map(idOf).sort());
  });

  it('limited, channel_3 viewOnMap only: the channel-3 sender only', async () => {
    await give('messages', ['read'], harness.sourceA);
    await give('channel_3', ['viewOnMap'], harness.sourceA);
    const ids = await expectMatchesLegacy(harness.limited, harness.sourceA);
    expect(ids).toEqual([idOf(HIDDEN)]);
  });

  it('limited, messages:read but no viewOnMap: no senders', async () => {
    await give('messages', ['read'], harness.sourceA);
    const ids = await expectMatchesLegacy(harness.limited, harness.sourceA);
    expect(ids).toEqual([]);
  });

  it('limited, viewOnMap granted on ANOTHER source only: no senders here', async () => {
    await give('messages', ['read'], harness.sourceA);
    await give('channel_0', ['viewOnMap'], harness.sourceB);
    const ids = await expectMatchesLegacy(harness.limited, harness.sourceA);
    expect(ids).toEqual([]);
  });

  it('limited, source B: a sender is judged by its channel on B, not on A', async () => {
    await give('messages', ['read'], harness.sourceB);
    await give('channel_0', ['viewOnMap'], harness.sourceB);
    // PEER is channel 0 on A but channel 3 on B, so B hides it.
    const ids = await expectMatchesLegacy(harness.limited, harness.sourceB);
    expect(ids).toEqual([idOf(B_ONLY)]);
  });

  it('limited, no source named: each source counted under its own grants', async () => {
    await give('messages', ['read'], harness.sourceA);
    await give('channel_0', ['viewOnMap'], harness.sourceA);
    await give('messages', ['read'], harness.sourceB);
    await give('channel_3', ['viewOnMap'], harness.sourceB);

    const [legacyA, legacyB] = await Promise.all([
      legacyVisibleSenders(harness.limited, harness.sourceA),
      legacyVisibleSenders(harness.limited, harness.sourceB),
    ]);
    const { counts, first } = await read(harness.limited, undefined);

    const expectedCounts: Record<string, number> = {};
    const expectedFirst: Record<string, number> = {};
    for (const legacy of [legacyA, legacyB]) {
      for (const id of legacy) {
        if (!(id in DM_COUNTS)) continue;
        expectedCounts[id] = (expectedCounts[id] ?? 0) + DM_COUNTS[id];
        expectedFirst[id] = Math.min(expectedFirst[id] ?? Infinity, DM_FIRST[id]);
      }
    }
    expect(counts).toEqual(expectedCounts);
    expect(first).toEqual(expectedFirst);
    // PEER and NOCHAN from A (channel 0), PEER from B (channel 3).
    expect(counts).toEqual({ [idOf(PEER)]: 2 * DM_COUNTS[idOf(PEER)], [idOf(NOCHAN)]: DM_COUNTS[idOf(NOCHAN)] });
    expect(getAllNodesAsync).not.toHaveBeenCalled();
  });
});
