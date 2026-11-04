/**
 * Per-peer DM and per-room history paging (#6186).
 *
 * The DM/room panes used to read the shared 100-message window, so once 100
 * newer messages arrived on any channel/DM, older DMs and room posts dropped
 * out ("No messages yet") even though the rows were still in the DB. The new
 * GET /messages/dm/:publicKey, /messages/room/:publicKey and /messages/dm-peers
 * routes serve each thread's own backlog with limit+1/offset paging.
 *
 * Real middleware and real SQL via the harness; only the manager registry is
 * stubbed (with real, never-connected MeshCoreManager instances).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';
import { channelKeyFingerprint } from '../services/meshcoreFrameIngest.js';
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

const SELF = 'aa'.repeat(32);
const PEER = 'bb'.repeat(32);
const PEER_PREFIX = 'bb'.repeat(6); // 12-hex inbound sender prefix
const ROOM = 'dd'.repeat(32);
const SENDER = 'ee'.repeat(32);

// A key that lives on source B, used to prove the DM route's key-access gate.
const SECRET = '0123456789abcdef0123456789abcdef';
const SECRET_B64 = Buffer.from(SECRET, 'hex').toString('base64');
const FP = channelKeyFingerprint(SECRET);
const KEY_SLOT = 3;

describe('MeshCore DM/room history paging (#6186)', () => {
  let harness: RouteTestHarness;
  let A: string;
  let B: string;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/:id/meshcore', meshcoreRoutes) });
    A = harness.sourceA;
    B = harness.sourceB;
    for (const [id, name] of [[A, 'Companion A'], [B, 'Companion B']] as const) {
      await databaseService.sources.deleteSource(id);
      await databaseService.sources.createSource({ id, name, type: 'meshcore', config: {}, enabled: true });
    }
    await databaseService.meshcore.deleteAllMessagesForSource(A);

    managers.clear();
    const mgrA = new MeshCoreManager(A);
    // getDmPeers resolves the non-self endpoint from the local node's key.
    (mgrA as unknown as { localNode: { publicKey: string } }).localNode = { publicKey: SELF };
    managers.set(A, mgrA);
    managers.set(B, new MeshCoreManager(B));
  });

  afterEach(async () => {
    await databaseService.meshcore.deleteAllMessagesForSource(A);
    await harness.cleanup();
  });

  const seedDm = (id: string, from: string, to: string, ts: number) =>
    databaseService.meshcore.insertMessage(
      { id, fromPublicKey: from, toPublicKey: to, text: id, timestamp: ts, createdAt: ts }, A,
    );
  const dmUrl = (pk: string) => `/${A}/meshcore/messages/dm/${pk}`;

  describe('permission gate', () => {
    it('refuses a user without messages:read on the source', async () => {
      await seedDm('out', SELF, PEER, 100);
      const agent = await harness.loginAs(harness.limited);
      expect((await agent.get(dmUrl(PEER))).status).toBe(403);
    });

    it('rejects a non-hex publicKey', async () => {
      await harness.grant(harness.limited.id, 'messages', 'read', A);
      const agent = await harness.loginAs(harness.limited);
      expect((await agent.get(dmUrl('not-hex'))).status).toBe(400);
    });
  });

  describe('a user who can read the source', () => {
    beforeEach(async () => {
      await harness.grant(harness.limited.id, 'messages', 'read', A);
    });

    it('returns a DM buried under 100+ newer channel messages (the regression)', async () => {
      await seedDm('dm-in', PEER_PREFIX, SELF, 1);   // inbound, stored under a prefix
      await seedDm('dm-out', SELF, PEER, 2);          // outbound, full key
      for (let i = 0; i < 150; i++) {
        await databaseService.meshcore.insertMessage(
          { id: `chan-${i}`, fromPublicKey: 'channel-1', toPublicKey: null, text: 'c', timestamp: 100 + i, createdAt: 100 + i }, A,
        );
      }
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(dmUrl(PEER));
      expect(res.status).toBe(200);
      // Both DM rows come back (oldest-first), matched prefix-aware on either end.
      expect(res.body.data.map((m: { id: string }) => m.id)).toEqual(['dm-in', 'dm-out']);
      expect(res.body.hasMore).toBe(false);
    });

    it('pages with limit+1/offset, oldest-first', async () => {
      await seedDm('d1', SELF, PEER, 10);
      await seedDm('d2', SELF, PEER, 20);
      await seedDm('d3', SELF, PEER, 30);
      const agent = await harness.loginAs(harness.limited);

      const first = await agent.get(`${dmUrl(PEER)}?limit=2&offset=0`);
      expect(first.body.data.map((m: { id: string }) => m.id)).toEqual(['d2', 'd3']);
      expect(first.body.hasMore).toBe(true);

      const second = await agent.get(`${dmUrl(PEER)}?limit=2&offset=2`);
      expect(second.body.data.map((m: { id: string }) => m.id)).toEqual(['d1']);
      expect(second.body.hasMore).toBe(false);
    });

    it('matches a bare prefix key too', async () => {
      await seedDm('dm-in', PEER_PREFIX, SELF, 1);
      await seedDm('dm-out', SELF, PEER, 2);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(dmUrl(PEER_PREFIX));
      expect(res.body.data.map((m: { id: string }) => m.id).sort()).toEqual(['dm-in', 'dm-out']);
    });

    it('lists DM peers from the DB, not the window', async () => {
      await seedDm('dm-in', PEER_PREFIX, SELF, 1);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/${A}/meshcore/messages/dm-peers`);
      expect(res.status).toBe(200);
      expect(res.body.data.map((p: { publicKey: string }) => p.publicKey)).toEqual([PEER_PREFIX]);
      expect(res.body.data[0].lastMessageAt).toBe(1);
    });

    it('returns room posts in sender-time order with paging', async () => {
      // createdAt uniform so only sender time (`timestamp`) can order these.
      const seedRoom = (id: string, ts: number) =>
        databaseService.meshcore.insertMessage(
          { id, fromPublicKey: SENDER, toPublicKey: ROOM, text: id, timestamp: ts, createdAt: 9_000, messageType: 'room_post' }, A,
        );
      await seedRoom('p1', 300);
      await seedRoom('p2', 320);
      await seedRoom('p3', 340);
      const agent = await harness.loginAs(harness.limited);

      const res = await agent.get(`/${A}/meshcore/messages/room/${ROOM}?limit=2`);
      expect(res.status).toBe(200);
      expect(res.body.data.map((m: { id: string }) => m.id)).toEqual(['p2', 'p3']); // newest two, oldest-first
      expect(res.body.hasMore).toBe(true);

      const stats = await agent.get(`/${A}/meshcore/messages/room-stats`);
      expect(stats.body.data).toEqual([{ roomPublicKey: ROOM, count: 3, latest: 340 }]);
    });
  });

  describe('key-access gate on DMs (#5551)', () => {
    beforeEach(async () => {
      await harness.grant(harness.limited.id, 'messages', 'read', A);
      await databaseService.channels.upsertChannel({ id: KEY_SLOT, name: 'ops', psk: SECRET_B64, role: 2 }, B);
      // A DM row carrying decrypt provenance for a key that lives on source B.
      await databaseService.meshcore.insertMessage({
        id: 'keyed-dm', fromPublicKey: PEER_PREFIX, toPublicKey: SELF, text: 'secret dm',
        timestamp: 10, createdAt: 10, keySourceId: B, keyChannelIdx: KEY_SLOT, keyFingerprint: FP,
      }, A);
    });
    afterEach(async () => { await databaseService.channels.deleteChannel(KEY_SLOT, B); });

    it('hides a keyed DM from a user without access to the key', async () => {
      const agent = await harness.loginAs(harness.limited);
      expect((await agent.get(dmUrl(PEER))).body.data).toEqual([]);
    });

    it('shows it once the user can read that key source channel', async () => {
      await harness.grant(harness.limited.id, `channel_${KEY_SLOT}`, 'read', B);
      const agent = await harness.loginAs(harness.limited);
      expect((await agent.get(dmUrl(PEER))).body.data.map((m: { id: string }) => m.id)).toEqual(['keyed-dm']);
    });

    it('admins see it regardless', async () => {
      const admin = await harness.loginAs(harness.admin);
      expect((await admin.get(dmUrl(PEER))).body.data.map((m: { id: string }) => m.id)).toEqual(['keyed-dm']);
    });
  });
});
