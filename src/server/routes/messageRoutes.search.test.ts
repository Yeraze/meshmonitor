/**
 * GET /api/messages/search (#5517) — scoped in SQL, dates in ms, virtual
 * channels for non-admins, and MeshCore read from the database.
 *
 * Real harness: these are permission and paging bugs, so the permission SQL
 * and the repository query must both be the real thing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { CHANNEL_DB_OFFSET } from '../constants/meshtastic.js';

// No managers registered: MeshCore search must not depend on a live manager.
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn(() => null),
    getAllManagers: vi.fn(() => []),
    getPrimaryMeshtasticSourceId: vi.fn(() => null),
    startManager: vi.fn(),
    stopManager: vi.fn(),
  },
}));

import messageRoutes from './messageRoutes.js';

const MC_SOURCE = 'rt-search-mc';
const T0 = 1_760_000_000_000;
const PEER = { nodeNum: 0x0c000002, nodeId: '!0c000002' };

describe('GET /api/messages/search', () => {
  let harness: RouteTestHarness;
  let seq = 0;

  const seed = async (sourceId: string, channel: number, text: string, time = T0 + ++seq * 1000) => {
    await harness.db.messages.insertMessage(
      {
        id: `${sourceId}_${PEER.nodeNum}_${9000 + ++seq}`,
        fromNodeNum: PEER.nodeNum,
        toNodeNum: 0xffffffff,
        fromNodeId: PEER.nodeId,
        toNodeId: '!ffffffff',
        text,
        channel,
        portnum: 1,
        timestamp: time,
        rxTime: time,
        createdAt: time,
      } as never,
      sourceId,
    );
  };

  const seedMc = async (text: string, extra: Record<string, unknown> = {}) => {
    seq++;
    await harness.db.meshcore.insertMessage(
      {
        id: `mcs-${seq}`,
        fromPublicKey: 'channel-0',
        fromName: 'Bob',
        toPublicKey: null,
        text,
        timestamp: T0 + seq * 1000,
        messageType: 'text',
        sourceId: MC_SOURCE,
        createdAt: T0 + seq * 1000,
        ...extra,
      } as never,
      MC_SOURCE,
    );
  };

  const texts = (body: { data: Array<{ text: string }> }) => body.data.map((m) => m.text).sort();

  beforeEach(async () => {
    seq = 0;
    harness = await createRouteTestApp({ mount: (app) => app.use('/', messageRoutes) });
    await harness.db.sources.deleteSource(MC_SOURCE).catch(() => {});
    await harness.db.sources.createSource({ id: MC_SOURCE, name: 'MC', type: 'meshcore', config: {}, enabled: true });
  });

  afterEach(async () => {
    await harness.db.messages.deleteAllMessages(harness.sourceA);
    await harness.db.messages.deleteAllMessages(harness.sourceB);
    await harness.db.meshcore.deleteAllMessagesForSource(MC_SOURCE);
    await harness.db.sources.deleteSource(MC_SOURCE).catch(() => {});
    await harness.cleanup();
  });

  it('treats startDate/endDate as milliseconds', async () => {
    await seed(harness.sourceA, 0, 'net check-in', T0);
    const agent = await harness.loginAs(harness.admin);
    const hit = await agent.get(`/search?q=net&startDate=${T0 - 60_000}&endDate=${T0 + 60_000}`);
    expect(hit.status).toBe(200);
    expect(texts(hit.body)).toEqual(['net check-in']);
    // The old client sent seconds; that range now (correctly) misses.
    const secs = await agent.get(`/search?q=net&startDate=${Math.floor((T0 - 60_000) / 1000)}&endDate=${Math.floor((T0 + 60_000) / 1000)}`);
    expect(secs.body.total).toBe(0);
  });

  it('scopes to sourceId in the query, so totals and pages are right', async () => {
    for (let i = 0; i < 3; i++) await seed(harness.sourceA, 0, `alpha ${i}`);
    for (let i = 0; i < 4; i++) await seed(harness.sourceB, 0, `alpha b${i}`);
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/search?q=alpha&sourceId=${harness.sourceA}&limit=2`);
    expect(res.body.total).toBe(3);
    expect(res.body.count).toBe(2);
    expect(res.body.data.every((m: { sourceId: string }) => m.sourceId === harness.sourceA)).toBe(true);
  });

  it('hides channels without a grant and returns nothing with no grants', async () => {
    await seed(harness.sourceA, 0, 'hello ch0');
    await seed(harness.sourceA, 2, 'hello ch2');
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.get('/search?q=hello')).body.total).toBe(0);

    await harness.grant(harness.limited.id, 'channel_0', 'read', harness.sourceA);
    const res = await agent.get('/search?q=hello');
    expect(texts(res.body)).toEqual(['hello ch0']);
  });

  it('lets a non-admin search a virtual channel they can read', async () => {
    const vcId = await harness.db.channelDatabase.createAsync({
      name: `Search VC ${Date.now()}`,
      psk: Buffer.alloc(16, 9).toString('base64'),
      pskLength: 16,
      isEnabled: true,
    });
    try {
      await seed(harness.sourceA, CHANNEL_DB_OFFSET + vcId, 'hello virtual');
      await harness.db.channelDatabase.setPermissionAsync({
        userId: harness.limited.id, channelDatabaseId: vcId, canRead: true, canViewOnMap: false,
      });
      const agent = await harness.loginAs(harness.limited);
      expect(texts((await agent.get('/search?q=hello')).body)).toEqual(['hello virtual']);
    } finally {
      await harness.db.channelDatabase.deletePermissionAsync(harness.limited.id, vcId).catch(() => {});
      await harness.db.channelDatabase.deleteAsync(vcId).catch(() => {});
    }
  });

  it('searches stored MeshCore messages with no manager connected', async () => {
    await seedMc('meshcore hello');
    await seedMc('meshcore dm hello', { fromPublicKey: 'bb'.repeat(32), fromName: null, toPublicKey: 'aa'.repeat(32) });
    const admin = await harness.loginAs(harness.admin);
    const all = await admin.get('/search?q=hello&scope=meshcore');
    expect(texts(all.body)).toEqual(['meshcore dm hello', 'meshcore hello']);
    expect(all.body.data[0].source).toBe('meshcore');

    // A channel grant reaches the channel, not the DM.
    await harness.grant(harness.limited.id, 'channel_0', 'read', MC_SOURCE);
    const limited = await harness.loginAs(harness.limited);
    expect(texts((await limited.get('/search?q=hello&scope=meshcore')).body)).toEqual(['meshcore hello']);
  });

  it('pages through Meshtastic results, then MeshCore', async () => {
    await seed(harness.sourceA, 0, 'page one');
    await seed(harness.sourceA, 0, 'page two');
    await seedMc('page three');
    const agent = await harness.loginAs(harness.admin);
    const first = await agent.get('/search?q=page&limit=2&offset=0');
    expect(first.body.total).toBe(3);
    expect(first.body.data.map((m: { source: string }) => m.source)).toEqual(['standard', 'standard']);
    const second = await agent.get('/search?q=page&limit=2&offset=2');
    expect(second.body.data.map((m: { text: string }) => m.text)).toEqual(['page three']);
  });
});
