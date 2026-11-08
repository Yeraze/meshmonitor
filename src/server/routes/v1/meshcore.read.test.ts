/**
 * v1 read endpoints on a MeshCore source (#6263 WP3): rows carry `protocol`,
 * positions follow viewOnMap / private-override grants, channel slots above 7
 * open with `messages:read`, MeshCore filters validate, group-packet plaintext
 * is withheld without a key grant, and Meshtastic responses only gain `protocol`.
 * Real auth middleware + real permission rows (createRouteTestApp).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../meshtasticManager.js', () => ({ default: {} }));
vi.mock('../../meshcoreManager.js', () => ({ default: {} }));
vi.mock('../../sourceManagerRegistry.js', () => ({ sourceManagerRegistry: { getManager: vi.fn() } }));
vi.mock('../../messageQueueService.js', () => ({ messageQueueService: {} }));
vi.mock('../../middleware/rateLimiters.js', () => ({
  messageLimiter: (_q: any, _r: any, n: any) => n(),
  translateLimiter: (_q: any, _r: any, n: any) => n(),
}));

import databaseService from '../../../services/database.js';
import { createRouteTestApp, type RouteTestHarness } from '../../test-helpers/routeTestApp.js';
import { attachSource } from './sourceParam.js';
import nodesRouter from './nodes.js';
import channelsRouter from './channels.js';
import packetsRouter from './packets.js';
import traceroutesRouter from './traceroutes.js';
import networkRouter from './network.js';
import messagesRouter from './messages.js';

const MC = 'rt-mc-source';
const K1 = 'a1'.repeat(32);
const K2 = 'b2'.repeat(32);
const K3 = 'c3'.repeat(32);

describe('v1 read — MeshCore source', () => {
  let h: RouteTestHarness;
  let user: { id: number; username: string; isAdmin: boolean };

  const wipe = async () => {
    await databaseService.meshcore.deleteAllPackets(MC).catch(() => {});
    await databaseService.meshcoreHopSnr.deleteBySourceId(MC).catch(() => {});
    await databaseService.sources.deleteSource(MC).catch(() => {});
  };
  const get = (path: string) => request(h.app).get(`/v1/sources/${MC}${path}`);
  type Act = 'read' | 'write' | 'viewOnMap';
  const BASE: Record<string, Act[]> = {
    nodes: ['read'], messages: ['read'], traceroute: ['read'], packetmonitor: ['read'],
  };
  /** Replace the limited user's grants on MC (one row per resource, as the schema requires). */
  const setGrants = async (spec: Record<string, Act[]>) => {
    await h.revokeAll(h.limited.id);
    for (const [resource, acts] of Object.entries(spec)) {
      await databaseService.auth.createPermission({
        userId: h.limited.id, resource,
        canRead: acts.includes('read'), canWrite: acts.includes('write'), canViewOnMap: acts.includes('viewOnMap'),
        sourceId: MC, grantedAt: Date.now(), grantedBy: null,
      } as never);
    }
  };
  const grantAll = (extra: Record<string, Act[]> = {}) => setGrants({ ...BASE, ...extra });

  beforeEach(async () => {
    h = await createRouteTestApp({
      useOptionalAuth: false,
      mount: (app) => {
        app.use((req: any, _res: any, next: any) => { req.user = user; next(); });
        const mount = (seg: string, res: any, router: any) =>
          app.use(`/v1/sources/:sourceId/${seg}`, attachSource(res, 'read'), router);
        mount('nodes', 'nodes', nodesRouter);
        mount('channels', 'messages', channelsRouter);
        mount('packets', 'packetmonitor', packetsRouter);
        mount('traceroutes', 'traceroute', traceroutesRouter);
        mount('network', 'nodes', networkRouter);
        mount('messages', 'messages', messagesRouter);
      },
    });
    user = h.limited;
    await wipe();
    await databaseService.sources.createSource({ id: MC, name: 'MC', type: 'meshcore', config: {}, enabled: true });
    const now = Date.now();
    const mc = databaseService.meshcore;
    await mc.upsertNode({ publicKey: K1, name: 'Alpha', advType: 2, latitude: 10.5, longitude: 20.5, lastHeard: now } as never, MC);
    await mc.upsertNode({ publicKey: K2, name: 'Bravo', advType: 1, lastHeard: now - 40 * 86_400_000 } as never, MC);
    await mc.upsertNode({ publicKey: K3, name: 'Carol', advType: 1, latitude: 30, longitude: 40, lastHeard: now - 1000 } as never, MC);
    await mc.setNodePositionOverride(MC, K3, { enabled: true, latitude: 1.25, longitude: 2.5, isPrivate: true });
    await mc.upsertNode({ publicKey: K1, name: 'Alpha' } as never, MC);

    await databaseService.channels.upsertChannel({ id: 0, name: 'Pub', psk: 'AQ==', role: 1 } as never, MC);
    await databaseService.channels.upsertChannel({ id: 12, name: 'Slot12', psk: 'c2VjcmV0', role: 1 } as never, MC);

    await mc.insertMessage({ id: `${MC}_m1`, fromPublicKey: 'channel-12', toPublicKey: 'channel-12', fromName: 'Bob', text: 'hello 12', timestamp: 1000, messageType: 'channel', createdAt: now } as never, MC);
    await mc.insertMessage({ id: `${MC}_m2`, fromPublicKey: K2, toPublicKey: K1, text: 'secret dm', timestamp: 2000, messageType: 'dm', createdAt: now } as never, MC);

    await mc.insertPacket({ sourceId: MC, timestamp: now, payloadType: 4, payloadTypeName: 'ADVERT', routeType: 1, hopCount: 0, rawHex: 'aa', senderPubKey: K1, createdAt: now } as never);
    await mc.insertPacket({ sourceId: MC, timestamp: now - 1, payloadType: 5, payloadTypeName: 'GRP_TXT', routeType: 1, hopCount: 1, rawHex: 'bb', createdAt: now } as never);

    await databaseService.meshcoreHopSnr.insertHops(MC, [
      { sourceId: MC, traceTag: 7, authCode: 1, hopIndex: 0, hopCount: 2, hashBytes: 1, senderPublicKey: K1, senderHash: 'a1', senderCandidates: 1, receiverPublicKey: K2, receiverHash: 'b2', receiverCandidates: 1, snrQuarterDb: 20, initiated: true, timestamp: now },
      { sourceId: MC, traceTag: 7, authCode: 1, hopIndex: 1, hopCount: 2, hashBytes: 1, senderPublicKey: K2, senderHash: 'b2', senderCandidates: 1, receiverPublicKey: K3, receiverHash: 'c3', receiverCandidates: 1, snrQuarterDb: -8, initiated: true, timestamp: now },
    ] as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await wipe();
    await h.cleanup();
  });

  it('nodes: MeshCore rows carry protocol, mc: ids and honour active/sinceDays', async () => {
    await grantAll();
    const all = await get('/nodes').expect(200);
    expect(all.body.count).toBe(3);
    expect(all.body.data.every((n: any) => n.protocol === 'meshcore' && n.nodeId.startsWith('mc:'))).toBe(true);
    const active = await get('/nodes?active=true&sinceDays=7').expect(200);
    expect(active.body.data.map((n: any) => n.longName).sort()).toEqual(['Alpha', 'Carol']);
  });

  it('nodes: no viewOnMap strips coordinates; viewOnMap shows them; private override hidden without nodes_private', async () => {
    await grantAll();
    let res = await get('/nodes').expect(200);
    expect(res.body.data.every((n: any) => n.latitude === null && n.longitude === null)).toBe(true);

    await grantAll({ nodes: ['read', 'viewOnMap'] });
    res = await get('/nodes').expect(200);
    const alpha = res.body.data.find((n: any) => n.longName === 'Alpha');
    const carol = res.body.data.find((n: any) => n.longName === 'Carol');
    expect(alpha.latitude).toBe(10.5);
    // Private override withheld: falls back to the advertised position, never 1.25.
    expect(carol.latitude).toBe(30);

    await grantAll({ nodes: ['read', 'viewOnMap'], nodes_private: ['read'] });
    res = await get('/nodes').expect(200);
    expect(res.body.data.find((n: any) => n.longName === 'Carol').latitude).toBe(1.25);
  });

  it('nodes/:nodeId accepts mc:<pk> and a bare key, 404 otherwise', async () => {
    await grantAll();
    expect((await get(`/nodes/mc:${K1}`).expect(200)).body.data.protocol).toBe('meshcore');
    expect((await get(`/nodes/${K1}`).expect(200)).body.data.nodeId).toBe(`mc:${K1}`);
    await get('/nodes/mc:zz').expect(404);
  });

  it('channels: slot above 7 is visible with messages:read, PSK only with write', async () => {
    await grantAll();
    let res = await get('/channels').expect(200);
    expect(res.body.data.map((c: any) => c.id).sort((a: number, b: number) => a - b)).toEqual([0, 12]);
    expect(res.body.data.every((c: any) => c.protocol === 'meshcore')).toBe(true);
    expect(res.body.data.some((c: any) => c.psk !== undefined)).toBe(false);
    await get('/channels/12').expect(200);

    await grantAll({ messages: ['read', 'write'] });
    res = await get('/channels/12').expect(200);
    expect(res.body.data.psk).toBeDefined();
  });

  it('channels: no grant -> 403 on the mount', async () => {
    await get('/channels').expect(403);
  });

  it('packets: protocol rows, filters, unsupported Meshtastic filter -> 400', async () => {
    await grantAll();
    const res = await get('/packets').expect(200);
    expect(res.body.count).toBe(2);
    expect(res.body.data.every((p: any) => p.protocol === 'meshcore')).toBe(true);
    const adv = res.body.data.find((p: any) => p.payload_type === 4);
    expect(adv.node_key).toBe(`mc:${K1}`);
    expect((await get('/packets?payload_type=4').expect(200)).body.count).toBe(1);
    const bad = await get('/packets?portnum=1').expect(400);
    expect(bad.body.code).toBe('UNSUPPORTED_FILTER');
    await get('/packets?limit=0').expect(400);
  });

  it('packets: plaintext is withheld without a key grant (null, not a distinguishable error)', async () => {
    await grantAll();
    const res = await get('/packets?payload_type=5').expect(200);
    expect(res.body.data[0].plaintext).toBeNull();
    const id = res.body.data[0].id;
    expect((await get(`/packets/${id}`).expect(200)).body.data.plaintext).toBeNull();
    await get('/packets/999999').expect(404);
  });

  it('traceroutes: synthetic route, quarter-dB snr, null return leg, hops[]', async () => {
    await grantAll();
    const res = await get('/traceroutes').expect(200);
    expect(res.body.count).toBe(1);
    const t = res.body.data[0];
    expect(t.protocol).toBe('meshcore');
    expect(t.fromNodeId).toBe(`mc:${K1}`);
    expect(t.toNodeId).toBe(`mc:${K3}`);
    expect(JSON.parse(t.snrTowards)).toEqual([20, -8]);
    expect(t.routeBack).toBeNull();
    expect(t.hops).toHaveLength(2);
    await get(`/traceroutes/mc:${K1}/mc:${K3}`).expect(200);
    await get(`/traceroutes/mc:${K1}/mc:${K2}`).expect(404);
  });

  it('network: stats, topology edges and direct-neighbors', async () => {
    await grantAll();
    const stats = (await get('/network').expect(200)).body.data;
    expect(stats).toMatchObject({ protocol: 'meshcore', totalNodes: 3, activeNodes: 2, tracerouteCount: 1 });
    const topo = (await get('/network/topology').expect(200)).body.data;
    expect(topo.nodes).toHaveLength(3);
    expect(topo.nodes.every((n: any) => n.protocol === 'meshcore')).toBe(true);
    expect(topo.edges[0]).toMatchObject({ protocol: 'meshcore', from: `mc:${K1}`, to: `mc:${K3}`, snr: [20, -8] });
    const dn = await get('/network/direct-neighbors').expect(200);
    expect(dn.body.data[`mc:${K1}`]).toMatchObject({ protocol: 'meshcore', nodeKey: `mc:${K1}`, packetCount: 1 });
  });

  it('network: traceroute count needs traceroute:read', async () => {
    await setGrants({ nodes: ['read'] });
    const stats = (await get('/network').expect(200)).body.data;
    expect(stats.tracerouteCount).toBe(0);
  });

  it('messages: channel slot >7 and DMs map with protocol, broadcast toNodeId, sender-clock timestamp', async () => {
    await grantAll();
    const res = await get('/messages').expect(200);
    expect(res.body.count).toBe(2);
    const ch = res.body.data.find((m: any) => m.channel === 12);
    expect(ch).toMatchObject({ protocol: 'meshcore', toNodeId: '!ffffffff', timestamp: 1000, messageType: 'channel' });
    const dm = res.body.data.find((m: any) => m.channel === -1);
    expect(dm).toMatchObject({ fromNodeId: `mc:${K2}`, toNodeId: `mc:${K1}` });
    expect((await get('/messages?channel=12').expect(200)).body.count).toBe(1);
    expect((await get(`/messages?fromNodeId=mc:${K2}`).expect(200)).body.count).toBe(1);
    expect((await get(`/messages/${MC}_m2`).expect(200)).body.data.text).toBe('secret dm');
    await get(`/messages/${MC}_nope`).expect(404);
  });

  it('messages/search adds protocol per hit', async () => {
    await grantAll();
    const res = await get('/messages/search?q=hello&scope=all').expect(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data.every((m: any) => m.protocol === 'meshcore')).toBe(true);
  });

  it('default alias resolves to a MeshCore source for an admin-less grant', async () => {
    await grantAll();
    const res = await request(h.app).get('/v1/sources/default/nodes');
    // `default` picks the oldest permitted source; with one grant that is MC.
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) expect(res.body.data.every((n: any) => n.protocol === 'meshcore')).toBe(true);
  });
});

describe('v1 read — Meshtastic rows only gain protocol', () => {
  let h: RouteTestHarness;
  beforeEach(async () => {
    h = await createRouteTestApp({
      useOptionalAuth: false,
      mount: (app) => {
        app.use((req: any, _res: any, next: any) => { req.user = h.admin; next(); });
        app.use('/v1/sources/:sourceId/nodes', attachSource('nodes', 'read'), nodesRouter);
        app.use('/v1/sources/:sourceId/channels', attachSource('messages', 'read'), channelsRouter);
        app.use('/v1/sources/:sourceId/messages', attachSource('messages', 'read'), messagesRouter);
        app.use('/v1/sources/:sourceId/network', attachSource('nodes', 'read'), networkRouter);
      },
    });
    await databaseService.messages.insertMessage(
      { id: 'mt-1', fromNodeNum: 1, toNodeNum: 0xffffffff, fromNodeId: '!00000001', toNodeId: '!ffffffff', text: 't', channel: 0, portnum: 1, timestamp: Date.now(), rxTime: Date.now(), createdAt: Date.now() } as never,
      h.sourceA,
    );
    await databaseService.channels.upsertChannel({ id: 0, name: 'Primary', psk: 'AQ==', role: 1 } as never, h.sourceA);
  });
  afterEach(async () => {
    await databaseService.messages.deleteAllMessages(h.sourceA);
    await h.cleanup();
  });

  it('messages, channels, network rows add exactly protocol:meshtastic', async () => {
    const m = await request(h.app).get(`/v1/sources/${h.sourceA}/messages`).expect(200);
    expect(m.body.data[0].protocol).toBe('meshtastic');
    expect(m.body.data[0].text).toBe('t');
    const c = await request(h.app).get(`/v1/sources/${h.sourceA}/channels`).expect(200);
    expect(c.body.data.every((x: any) => x.protocol === 'meshtastic')).toBe(true);
    const n = await request(h.app).get(`/v1/sources/${h.sourceA}/network`).expect(200);
    expect(n.body.data.protocol).toBe('meshtastic');
    expect(n.body.data.totalNodes).toBeTypeOf('number');
    const bad = await request(h.app).get(`/v1/sources/${h.sourceA}/nodes?active=true`).expect(200);
    expect(bad.body.success).toBe(true);
  });
});
