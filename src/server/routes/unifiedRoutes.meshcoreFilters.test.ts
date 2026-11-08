/**
 * /api/unified/packets + /packets/distribution with MeshCore filters and
 * protocol-tagged distribution (#6262). Real-middleware harness.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import unifiedRoutes from './unifiedRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const MC = 'mcflt-mc';
const MC2 = 'mcflt-mc2';
const PUB = 'ab'.repeat(32);

describe('unified packets: MeshCore filters and distribution (#6262)', () => {
  let harness: RouteTestHarness;
  const now = Date.now();

  beforeEach(async () => {
    harness = await createRouteTestApp({
      useOptionalAuth: false,
      mount: (app) => app.use('/api/unified', unifiedRoutes),
    });
    for (const id of [MC, MC2]) {
      await harness.db.sources.deleteSource(id).catch(() => {});
      await harness.db.sources.createSource({ id, name: id, type: 'meshcore', config: {}, enabled: true });
    }
    const mcp = (sourceId: string, payloadType: number, name: string, over: object = {}) =>
      harness.db.meshcore.insertPacket({
        sourceId, timestamp: now - 1000, payloadType, payloadTypeName: name, routeType: 1, routeTypeName: 'FLOOD',
        rawHex: 'aa', createdAt: now, ...over,
      } as never);
    // payload 4 collides numerically with Meshtastic portnum 4 (NODEINFO).
    await mcp(MC, 4, 'ADVERT', { senderPubKey: PUB, advertName: 'Hilltop' });
    await mcp(MC, 4, 'ADVERT', { senderPubKey: PUB, advertName: 'Hilltop' });
    await mcp(MC, 5, 'GRP_TXT');
    await mcp(MC2, 4, 'ADVERT', { senderPubKey: PUB });
    for (const sid of [harness.sourceA]) {
      await harness.db.packetLog.insertPacketLog(
        { timestamp: now - 500, from_node: 0x11, from_node_id: '!00000011', portnum: 4, portnum_name: 'NODEINFO_APP', encrypted: false } as never,
        sid,
      );
      await harness.db.packetLog.insertPacketLog(
        { timestamp: now - 400, from_node: 0x11, from_node_id: '!00000011', portnum: 1, portnum_name: 'TEXT_MESSAGE_APP', encrypted: false } as never,
        sid,
      );
    }
  });

  afterEach(async () => {
    for (const id of [MC, MC2]) {
      await harness.db.meshcore.deleteAllPackets(id).catch(() => {});
      await harness.db.sources.deleteSource(id).catch(() => {});
    }
    await harness.db.packetLog.clearPacketLogs(harness.sourceA).catch(() => {});
    await harness.cleanup();
  });

  const get = async (path: string) => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(path);
    expect(res.status).toBe(200);
    return res.body;
  };

  it('payload_type excludes Meshtastic sources', async () => {
    const body = await get('/api/unified/packets?payload_type=4&limit=50');
    expect(body.packets.length).toBe(3);
    expect(body.packets.every((p: any) => p.sourceId === MC || p.sourceId === MC2)).toBe(true);
  });

  it('MeshCore rows carry the derived sender name in from_node_longName', async () => {
    const body = await get('/api/unified/packets?payload_type=4&limit=50');
    const adverts = body.packets.filter((p: any) => p.sourceId === MC);
    expect(adverts.length).toBeGreaterThan(0);
    expect(adverts.every((p: any) => p.from_node_longName === 'Hilltop' && p.from_node === 0 && p.from_node_id === null)).toBe(true);
  });

  it('route_type alone also excludes Meshtastic', async () => {
    const body = await get('/api/unified/packets?route_type=1&limit=50');
    expect(body.packets.some((p: any) => p.sourceId === harness.sourceA)).toBe(false);
    expect(body.packets.length).toBe(4);
  });

  it('portnum excludes MeshCore sources (unchanged)', async () => {
    const body = await get('/api/unified/packets?portnum=4&limit=50');
    expect(body.packets.length).toBe(1);
    expect(body.packets[0].sourceId).toBe(harness.sourceA);
  });

  it('distribution tags entries by protocol with no key collision', async () => {
    const body = await get('/api/unified/packets/distribution');
    const mt4 = body.byType.find((t: any) => t.portnum === 4 && t.protocol === 'meshtastic');
    const mc4 = body.byType.find((t: any) => t.portnum === 4 && t.protocol === 'meshcore');
    expect(mt4.count).toBe(1);
    expect(mc4.count).toBe(3); // two sources merged
    expect(mc4.portnum_name).toBe('MeshCore ADVERT');
    const dev = body.byDevice.find((d: any) => d.protocol === 'meshcore');
    expect(dev).toMatchObject({ from_node: 0, from_node_id: null, publicKey: PUB, count: 3, from_node_longName: 'Hilltop' });
    expect(body.byDevice.find((d: any) => d.protocol === 'meshtastic').from_node).toBe(0x11);
    expect(body.total).toBe(6);
    const per = Object.fromEntries(body.bySource.map((s: any) => [s.sourceId, s.count]));
    expect(per[MC]).toBe(3);
    expect(per[MC2]).toBe(1);
  });

  it('distribution omits sources the user cannot read', async () => {
    await harness.grant(harness.limited.id, 'packetmonitor', 'read', MC);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/api/unified/packets/distribution');
    expect(res.status).toBe(200);
    expect(res.body.bySource.map((s: any) => s.sourceId)).toEqual([MC]);
    expect(res.body.total).toBe(3);
  });
});
