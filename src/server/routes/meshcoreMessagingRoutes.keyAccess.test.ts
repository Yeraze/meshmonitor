/**
 * Keyed MeshCore channel messages — read gate (#5551).
 *
 * A repeater source (A) stores a channel message it decrypted with a key that
 * lives on a companion source (B). Reading it must need BOTH the usual access
 * on A and read access to that key's channel on a source that holds it. A user
 * who can read A's messages but not the channel on B must not see it anywhere:
 * the channel page, the recent tail, the counts / unread markers, the channel
 * list, search, or the live socket gate.
 *
 * Real middleware and real SQL via the harness; only the manager registry is
 * stubbed (with real MeshCoreManager instances, never connected).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';
import { channelKeyFingerprint, keyedChannelIndex } from '../services/meshcoreFrameIngest.js';
import { resolveMeshcoreKeyAccess, canSeeKeyedMessage } from '../utils/meshcoreKeyAccess.js';
import { searchReadableMessages } from '../utils/messageSearch.js';
import type { MeshCoreManager as MeshCoreManagerType } from '../meshcoreManager.js';

const managers = new Map<string, MeshCoreManagerType>();
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn((id: string) => managers.get(id)),
    getAllManagers: vi.fn(() => [...managers.values()]),
  },
}));
vi.mock('../sourceManagerTypes.js', () => ({
  isMeshCoreManager: (m: unknown) => !!m,
  isAnyMeshCoreManager: (m: unknown) => !!m,
  isMeshCoreMqttManager: () => false,
  isMeshtasticManager: () => false,
  getPrimaryMeshtasticManager: () => null,
}));

const { MeshCoreManager } = await import('../meshcoreManager.js');
const { default: meshcoreRoutes } = await import('./meshcoreRoutes.js');
const { default: channelRoutes } = await import('./channelRoutes.js');

const SECRET = '0123456789abcdef0123456789abcdef';
const SECRET_B64 = Buffer.from(SECRET, 'hex').toString('base64');
const FP = channelKeyFingerprint(SECRET);
const IDX = keyedChannelIndex(SECRET);
const KEY_SLOT = 3;

describe('keyed MeshCore channel messages — read gate (#5551)', () => {
  let harness: RouteTestHarness;
  let A: string;
  let B: string;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => {
        app.use('/:id/meshcore', meshcoreRoutes);
        app.use('/channels', channelRoutes);
      },
    });
    A = harness.sourceA;
    B = harness.sourceB;
    // The harness seeds Meshtastic sources; these two are MeshCore.
    for (const [id, name] of [[A, 'Repeater'], [B, 'Companion']] as const) {
      await databaseService.sources.deleteSource(id);
      await databaseService.sources.createSource({ id, name, type: 'meshcore', config: {}, enabled: true });
    }
    await databaseService.channels.upsertChannel({ id: KEY_SLOT, name: 'ops', psk: SECRET_B64, role: 2 }, B);

    await databaseService.meshcore.deleteAllMessagesForSource(A);
    const keyed = {
      id: 'rpt_keyed_1',
      fromPublicKey: `channel-${IDX}`,
      fromName: 'Alice',
      text: 'keyed secret text',
      timestamp: 5_000,
      messageType: 'channel',
      keySourceId: B,
      keyChannelIdx: KEY_SLOT,
      keyFingerprint: FP,
      createdAt: 5_000,
    };
    await databaseService.meshcore.insertMessage(keyed, A);
    // An ordinary DM on A, to prove unkeyed rows are untouched by the gate.
    await databaseService.meshcore.insertMessage({
      id: 'plain_1', fromPublicKey: 'aa'.repeat(32), toPublicKey: 'bb'.repeat(32),
      text: 'plain dm', timestamp: 4_000, createdAt: 4_000,
    }, A);

    managers.clear();
    const mgrA = new MeshCoreManager(A);
    (mgrA as unknown as { messages: unknown[] }).messages = [
      { id: 'plain_1', fromPublicKey: 'aa'.repeat(32), toPublicKey: 'bb'.repeat(32), text: 'plain dm', timestamp: 4_000 },
      { ...keyed, sourceId: A },
    ];
    managers.set(A, mgrA);
    managers.set(B, new MeshCoreManager(B));
  });

  afterEach(async () => {
    await databaseService.meshcore.deleteAllMessagesForSource(A);
    await databaseService.channels.deleteChannel(KEY_SLOT, B);
    await harness.cleanup();
  });

  const chanUrl = () => `/${A}/meshcore/messages/channel/${IDX}`;
  const countsUrl = () => `/${A}/meshcore/messages/channel-counts?channels=${IDX}`;
  const listUrl = () => `/channels/all?sourceId=${A}`;

  describe('a user who can read the repeater source but NOT the key source', () => {
    beforeEach(async () => {
      await harness.grant(harness.limited.id, 'messages', 'read', A);
    });

    it('gets an empty channel page', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(chanUrl());
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it('does not see it in the recent tail, but still sees unkeyed messages', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/${A}/meshcore/messages`);
      expect(res.status).toBe(200);
      expect(res.body.data.map((m: { id: string }) => m.id)).toEqual(['plain_1']);
    });

    it('gets no count and no unread marker for the channel', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(countsUrl());
      expect(res.status).toBe(200);
      expect(res.body.counts[IDX] ?? 0).toBe(0);
      expect(res.body.latestTimestamps[IDX]).toBeUndefined();
    });

    it('does not see the channel in the channel list', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(listUrl());
      expect(res.status).toBe(200);
      expect(res.body.map((c: { id: number }) => c.id)).not.toContain(IDX);
    });

    it('cannot find it by search', async () => {
      const user = await databaseService.findUserByIdAsync(harness.limited.id);
      const found = await searchReadableMessages(user, A, { query: 'keyed secret', scope: 'meshcore', limit: 10, offset: 0 } as never);
      expect(found.total).toBe(0);
      const plain = await searchReadableMessages(user, A, { query: 'plain dm', scope: 'meshcore', limit: 10, offset: 0 } as never);
      expect(plain.total).toBe(1);
    });

    it('is refused by the gate the live socket uses', async () => {
      const access = await resolveMeshcoreKeyAccess({ id: harness.limited.id, isAdmin: false });
      expect(access).toEqual([]);
      expect(canSeeKeyedMessage(access, { keyFingerprint: FP })).toBe(false);
      expect(canSeeKeyedMessage(access, { keyFingerprint: null })).toBe(true);
    });
  });

  describe('a user who can also read that channel on the key source', () => {
    beforeEach(async () => {
      await harness.grant(harness.limited.id, 'messages', 'read', A);
      await harness.grant(harness.limited.id, `channel_${KEY_SLOT}`, 'read', B);
    });

    it('reads the message, the count, and the channel entry', async () => {
      const agent = await harness.loginAs(harness.limited);

      const page = await agent.get(chanUrl());
      expect(page.body.data.map((m: { text: string }) => m.text)).toEqual(['keyed secret text']);

      const tail = await agent.get(`/${A}/meshcore/messages`);
      expect(tail.body.data.map((m: { id: string }) => m.id).sort()).toEqual(['plain_1', 'rpt_keyed_1']);

      const counts = await agent.get(countsUrl());
      expect(counts.body.counts[IDX]).toBe(1);
      expect(counts.body.latestTimestamps[IDX]).toBe(5_000);

      const list = await agent.get(listUrl());
      const entry = list.body.find((c: { id: number }) => c.id === IDX);
      expect(entry).toMatchObject({ name: 'ops', keyed: true, readOnly: true });
      // The key never rides the list entry.
      expect(entry.psk).toBeUndefined();
      expect(JSON.stringify(list.body)).not.toContain(SECRET_B64);
    });

    it('messages:read on the key source works too (the other half of the channel rule)', async () => {
      await harness.cleanup();
      // Re-seed after cleanup dropped the sources and grants.
      harness = await createRouteTestApp({ mount: (app) => app.use('/:id/meshcore', meshcoreRoutes) });
      await harness.grant(harness.limited.id, 'messages', 'read', B);
      const access = await resolveMeshcoreKeyAccess({ id: harness.limited.id, isAdmin: false });
      expect(access).toEqual([FP]);
    });
  });

  it('key access alone is not enough: the repeater source still needs its own grant', async () => {
    await harness.grant(harness.limited.id, `channel_${KEY_SLOT}`, 'read', B);
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.get(chanUrl())).status).toBe(403);
    const list = await agent.get(listUrl());
    expect(list.body.map((c: { id: number }) => c.id)).not.toContain(IDX);
  });

  it('once no source holds the key, non-admins lose the rows and admins keep them', async () => {
    await harness.grant(harness.limited.id, 'messages', 'read', A);
    await harness.grant(harness.limited.id, 'messages', 'read', B);
    await databaseService.channels.deleteChannel(KEY_SLOT, B);

    const limited = await harness.loginAs(harness.limited);
    expect((await limited.get(chanUrl())).body.data).toEqual([]);

    const admin = await harness.loginAs(harness.admin);
    expect((await admin.get(chanUrl())).body.data).toHaveLength(1);
    const list = await admin.get(listUrl());
    expect(list.body.map((c: { id: number }) => c.id)).toContain(IDX);
  });

  it('admins see everything', async () => {
    const admin = await harness.loginAs(harness.admin);
    expect((await admin.get(chanUrl())).body.data).toHaveLength(1);
    expect((await admin.get(countsUrl())).body.counts[IDX]).toBe(1);
    expect(await resolveMeshcoreKeyAccess({ id: harness.admin.id, isAdmin: true })).toBe('all');
  });

  it('anonymous viewers get nothing keyed', async () => {
    expect(await resolveMeshcoreKeyAccess(null)).toEqual([]);
  });
});
