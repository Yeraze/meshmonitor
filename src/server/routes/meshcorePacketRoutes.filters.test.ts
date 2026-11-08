/**
 * MeshCore packet routes: filters, keyset cursor, distribution (#6262 P4).
 * Real permission enforcement through `createRouteTestApp()`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import meshcorePacketRoutes from './meshcorePacketRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';
import meshcorePacketLogService from '../services/meshcorePacketLogService.js';

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn().mockReturnValue(null),
    getAllManagers: vi.fn().mockReturnValue([]),
  },
}));

const KEY = 'ab'.repeat(32);

async function insert(sourceId: string, over: Record<string, unknown> = {}) {
  await databaseService.meshcore.insertPacket({
    sourceId,
    timestamp: Date.now(),
    payloadType: 4,
    payloadTypeName: 'ADVERT',
    routeType: 1,
    routeTypeName: 'FLOOD',
    rawHex: 'aa',
    createdAt: Date.now(),
    ...over,
  } as never);
}

describe('MeshCore packet routes — filters, cursor, distribution (#6262)', () => {
  let harness: RouteTestHarness;
  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/:id/meshcore', meshcorePacketRoutes) });
    await databaseService.settings.setSetting('meshcore_packet_log_enabled', '1');
    await databaseService.meshcore.deleteAllPackets();
  });
  afterEach(async () => {
    await harness.cleanup();
  });

  it('paginates with cursor, hasMore and nextCursor', async () => {
    for (let i = 1; i <= 5; i++) await insert(harness.sourceA, { timestamp: 1_700_000_000_000 + i, rawHex: `0${i}` });
    const agent = await harness.loginAs(harness.admin);
    const p1 = await agent.get(`/${harness.sourceA}/meshcore/packets?limit=2`);
    expect(p1.status).toBe(200);
    expect(p1.body.packets).toHaveLength(2);
    expect(p1.body.hasMore).toBe(true);
    expect(p1.body.total).toBe(5);
    expect(p1.body.nextCursor).toMatch(/^\d+_\d+$/);
    const p2 = await agent.get(`/${harness.sourceA}/meshcore/packets?limit=2&cursor=${p1.body.nextCursor}`);
    expect(p2.body.packets.map((p: { rawHex: string }) => p.rawHex)).toEqual(['03', '02']);
    const p3 = await agent.get(`/${harness.sourceA}/meshcore/packets?limit=2&cursor=${p2.body.nextCursor}`);
    expect(p3.body.packets).toHaveLength(1);
    expect(p3.body.hasMore).toBe(false);
    expect(p3.body.nextCursor).toBeNull();
  });

  it('applies search, src_hash, sender and path_hash filters', async () => {
    await insert(harness.sourceA, { srcHash: 'ab', senderPubKey: KEY, advertName: 'Hilltop', pathHops: 'a3,7f', rawHex: '01' });
    await insert(harness.sourceA, { srcHash: 'cd', advertName: 'Other', pathHops: '02', rawHex: '02' });
    const agent = await harness.loginAs(harness.admin);
    const get = async (qs: string) => (await agent.get(`/${harness.sourceA}/meshcore/packets?${qs}`)).body.packets.length;
    expect(await get('search=hilltop')).toBe(1);
    expect(await get('src_hash=cd')).toBe(1);
    expect(await get('sender=abab')).toBe(1);
    expect(await get('advert_pubkey=abab')).toBe(1);
    expect(await get('path_hash=7f')).toBe(1);
    const ex = await agent.get(`/${harness.sourceA}/meshcore/packets/export?src_hash=cd`);
    expect(ex.text.trim().split('\n')).toHaveLength(1);
    const gr = await agent.get(`/${harness.sourceA}/meshcore/packets/grouped?search=hilltop`);
    expect(gr.body.packets).toHaveLength(1);
  });

  it('rejects bad filter values with 400', async () => {
    const agent = await harness.loginAs(harness.admin);
    for (const qs of ['src_hash=zz', 'src_hash=abc', 'path_hash=a', 'sender=xyz', `search=${'x'.repeat(101)}`, 'cursor=bad']) {
      const res = await agent.get(`/${harness.sourceA}/meshcore/packets?${qs}`);
      expect(res.status, qs).toBe(400);
      expect(res.body.success).toBe(false);
    }
    const d = await agent.get(`/${harness.sourceA}/meshcore/packets/stats/distribution?src_hash=zz`);
    expect(d.status).toBe(400);
  });

  it('returns the distribution shape', async () => {
    await insert(harness.sourceA, { senderPubKey: KEY, advertName: 'Hilltop', rawHex: '01' });
    await insert(harness.sourceA, { payloadType: 2, payloadTypeName: 'TXT_MSG', routeType: 2, routeTypeName: 'DIRECT', rawHex: '02' });
    await insert(harness.sourceB, { rawHex: '03' });
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/${harness.sourceA}/meshcore/packets/stats/distribution`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.enabled).toBe(true);
    expect(res.body.byPayloadType).toHaveLength(2);
    expect(res.body.byRouteType).toHaveLength(2);
    expect(res.body.topSenders).toEqual([{ senderPubKey: KEY, advertName: 'Hilltop', count: 1 }]);
  });

  it('requires packetmonitor:read on that source', async () => {
    await harness.grant(harness.limited.id, 'packetmonitor', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.get(`/${harness.sourceA}/meshcore/packets/stats/distribution`)).status).toBe(200);
    expect((await agent.get(`/${harness.sourceB}/meshcore/packets/stats/distribution`)).status).toBe(403);
  });

  it('logPacket stores the derived fields', async () => {
    const advertHex = '11' + '00' + KEY + '00000000' + '00'.repeat(64) + '81' + Buffer.from('Hilltop').toString('hex');
    await meshcorePacketLogService.logPacket({
      sourceId: harness.sourceA, timestamp: Date.now(), payloadType: 4, rawHex: advertHex, createdAt: Date.now(),
    });
    const [row] = await databaseService.meshcore.getPackets({ sourceId: harness.sourceA });
    expect(row.srcHash).toBe('ab');
    expect(row.senderPubKey).toBe(KEY);
    expect(row.advertName).toBe('Hilltop');
  });
});
