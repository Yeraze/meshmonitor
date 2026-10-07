/**
 * GET /api/messages/first-unread (#4607)
 *
 * The unread-divider anchor endpoint. The query itself is covered against all
 * three backends in `src/db/repositories/notifications.test.ts`; what matters
 * here is that the route never hands a caller an anchor for a conversation
 * whose unread BADGE they are not allowed to see — the same gates
 * `/unread-counts` applies.
 *
 * Real session, auth middleware and permission rows via createRouteTestApp.
 * The query is stubbed to a fixed answer; the manager is a fake. Reads with no
 * `sourceId` are covered in `perSourceReads.scope.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import databaseService from '../../services/database.js';
import messageRoutes from './messageRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';
import { loadAllNodesAsDeviceInfo } from '../utils/dbNodeMapper.js';

const LOCAL_ID = '!000003e7';
const PEER_NUM = 0x0000aa01;
const PEER = '!0000aa01';
const HIDDEN_NUM = 0x0000aa02;
const HIDDEN = '!0000aa02';

const RAW = {
  channels: { 0: 1000, 5: 2000 },
  directMessages: { [PEER]: 3000, [HIDDEN]: 4000 },
};

describe('GET /api/messages/first-unread (#4607)', () => {
  let harness: RouteTestHarness;
  let query: ReturnType<typeof vi.spyOn>;

  /** One permission row carrying several actions. */
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

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/api/messages', messageRoutes) });
    await sourceManagerRegistry.addManager({
      sourceId: harness.sourceA,
      sourceType: 'meshtastic_tcp',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue({ sourceId: harness.sourceA, sourceType: 'meshtastic_tcp', connected: true }),
      getLocalNodeInfo: vi.fn().mockReturnValue({ nodeNum: 999, nodeId: LOCAL_ID }),
      getAllNodesAsync: vi.fn((id?: string) => loadAllNodesAsDeviceInfo(id)),
    } as unknown as ISourceManager);
    // The peer is heard on channel 0, the hidden node on channel 3.
    await databaseService.nodes.upsertNode({ nodeNum: PEER_NUM, nodeId: PEER, longName: 'peer', shortName: 'P', channel: 0 }, harness.sourceA);
    await databaseService.nodes.upsertNode({ nodeNum: HIDDEN_NUM, nodeId: HIDDEN, longName: 'hidden', shortName: 'H', channel: 3 }, harness.sourceA);
    query = vi.spyOn(databaseService, 'getFirstUnreadTimestampsAsync').mockResolvedValue(RAW);
  });

  afterEach(async () => {
    await sourceManagerRegistry.removeManager(harness.sourceA);
    vi.restoreAllMocks();
    await harness.cleanup();
  });

  const get = async (user: RouteTestHarness['limited'] | null, queryString: Record<string, string> = {}) =>
    (await harness.loginAs(user)).get('/api/messages/first-unread').query({ sourceId: harness.sourceA, ...queryString });

  it('403s a caller with neither channel nor message read permission', async () => {
    const res = await get(harness.limited);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(query).not.toHaveBeenCalled();
  });

  it('returns channel and DM anchors for an admin, in the ok() envelope', async () => {
    const res = await get(harness.admin);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.channels).toEqual({ 0: 1000, 5: 2000 });
    expect(res.body.data.directMessages).toEqual({ [PEER]: 3000, [HIDDEN]: 4000 });
  });

  it('drops channels the caller cannot read, and DMs from nodes the caller cannot see', async () => {
    // channel_0 granted, channel_5 and channel_3 not.
    await give('channel_0', ['read', 'viewOnMap'], harness.sourceA);
    await give('messages', ['read'], harness.sourceA);

    const res = await get(harness.limited);

    expect(res.status).toBe(200);
    expect(res.body.data.channels).toEqual({ 0: 1000 });
    // The hidden node was last heard on channel 3.
    expect(res.body.data.directMessages).toEqual({ [PEER]: 3000 });
  });

  it('omits DM anchors entirely without messages:read', async () => {
    await give('channel_0', ['read', 'viewOnMap'], harness.sourceA);

    const res = await get(harness.limited);

    expect(res.status).toBe(200);
    expect(res.body.data.directMessages).toEqual({});
  });

  it('forwards sourceId and excludeMqtt to the query', async () => {
    await get(harness.admin, { excludeMqtt: 'true' });

    expect(query).toHaveBeenCalledWith(harness.admin.id, LOCAL_ID, harness.sourceA, true);
  });

  it('reports 500 through the fail() envelope when the query throws', async () => {
    query.mockRejectedValue(new Error('boom'));

    const res = await get(harness.admin);

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('FIRST_UNREAD_FAILED');
  });
});
