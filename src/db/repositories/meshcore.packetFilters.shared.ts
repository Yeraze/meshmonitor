/** Shared assertions for packet filter / distribution tests across backends (#6262). */
import { it, expect } from 'vitest';
import type { MeshCoreRepository, DbMeshCorePacket } from './meshcore.js';

const K1 = 'ab'.repeat(32);
const K2 = 'cd'.repeat(32);

export function mkPacket(o: Partial<DbMeshCorePacket> = {}): DbMeshCorePacket {
  return {
    sourceId: 'S',
    timestamp: 1000,
    payloadType: 4,
    payloadTypeName: 'ADVERT',
    routeType: 1,
    routeTypeName: 'FLOOD',
    pathHops: null,
    rawHex: 'deadbeef',
    createdAt: 1000,
    ...o,
  };
}

export function sharedPacketFilterBehaviour(getRepo: () => MeshCoreRepository) {
  async function seed() {
    const r = getRepo();
    await r.insertPacket(mkPacket({ timestamp: 1, srcHash: 'ab', senderPubKey: K1, advertName: 'Hilltop', rawHex: 'aa11', pathHops: 'a3,7f' }));
    await r.insertPacket(mkPacket({ timestamp: 2, srcHash: 'cd', senderPubKey: K2, advertName: 'Valley', rawHex: 'bb22', pathHops: '7f' }));
    await r.insertPacket(mkPacket({ timestamp: 3, srcHash: 'ab', senderPubKey: K1, advertName: 'Hilltop', rawHex: 'aa33', pathHops: '02,a3,55' }));
    await r.insertPacket(mkPacket({ timestamp: 4, payloadType: 2, payloadTypeName: 'TXT_MSG', routeType: 2, routeTypeName: 'DIRECT', srcHash: 'ab', rawHex: 'cc44', pathHops: 'a3' }));
    await r.insertPacket(mkPacket({ timestamp: 5, payloadType: 5, payloadTypeName: 'GRP_TXT', rawHex: 'dd55' }));
  }

  it('search matches advert name, type name, raw hex and sender key', async () => {
    const r = getRepo();
    await seed();
    expect(await r.getPackets({ sourceId: 'S', search: 'hilltop' })).toHaveLength(2);
    expect(await r.getPackets({ sourceId: 'S', search: 'grp_' })).toHaveLength(1);
    expect(await r.getPackets({ sourceId: 'S', search: 'bb22' })).toHaveLength(1);
    expect(await r.getPackets({ sourceId: 'S', search: 'cdcd' })).toHaveLength(1);
  });

  it('srcHash matches the stored hash or a sender key prefix', async () => {
    const r = getRepo();
    await seed();
    expect(await r.getPackets({ sourceId: 'S', srcHash: 'ab' })).toHaveLength(3);
    expect(await r.getPackets({ sourceId: 'S', srcHash: 'cd' })).toHaveLength(1);
  });

  it('senderPubKey is a prefix match', async () => {
    const r = getRepo();
    await seed();
    expect(await r.getPackets({ sourceId: 'S', senderPubKey: 'abab' })).toHaveLength(2);
    expect(Number(await r.getPacketCount({ sourceId: 'S', senderPubKey: K2 }))).toBe(1);
  });

  it('pathHash matches first, middle, last and sole hops but not substrings', async () => {
    const r = getRepo();
    await seed();
    // a3: first of "a3,7f", middle of "02,a3,55", sole "a3"
    expect(await r.getPackets({ sourceId: 'S', pathHash: 'a3' })).toHaveLength(3);
    expect(await r.getPackets({ sourceId: 'S', pathHash: '7f' })).toHaveLength(2);
    expect(await r.getPackets({ sourceId: 'S', pathHash: '55' })).toHaveLength(1);
    expect(await r.getPackets({ sourceId: 'S', pathHash: 'a' })).toHaveLength(0);
  });

  it('keyset cursor pages newest-first without overlap', async () => {
    const r = getRepo();
    await seed();
    const p1 = await r.getPackets({ sourceId: 'S', limit: 2 });
    expect(p1.map((p) => Number(p.timestamp))).toEqual([5, 4]);
    const last = p1[1];
    const p2 = await r.getPackets({ sourceId: 'S', limit: 2, untilTs: Number(last.timestamp), untilId: Number(last.id) });
    expect(p2.map((p) => Number(p.timestamp))).toEqual([3, 2]);
  });

  it('distribution counts rows by type, route and top ADVERT senders', async () => {
    const r = getRepo();
    await seed();
    const d = await r.getPacketDistribution({ sourceId: 'S' });
    expect(d.total).toBe(5);
    expect(d.byPayloadType.find((x) => x.payloadType === 4)?.count).toBe(3);
    expect(d.byRouteType.find((x) => x.routeType === 2)?.count).toBe(1);
    expect(d.topSenders).toEqual([
      { senderPubKey: K1, advertName: 'Hilltop', count: 2 },
      { senderPubKey: K2, advertName: 'Valley', count: 1 },
    ]);
    const f = await r.getPacketDistribution({ sourceId: 'S', pathHash: '7f' });
    expect(f.total).toBe(2);
  });
}
