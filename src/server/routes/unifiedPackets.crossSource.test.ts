/**
 * GET /api/unified/packets — cross-source tags + filter (#5559).
 *
 * Real-middleware harness: real sessions, permissions, packet_log,
 * meshcore_packet_log and settings rows. The permission rule under test: a
 * tag names another source only when the caller can read BOTH sources under
 * packetmonitor:read; a caller who can read one source never sees a tag.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import unifiedRoutes from './unifiedRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { localNodeNumSettingKey } from '../../db/repositories/settings.js';

const NUM_A = 0x5a000001;
const NUM_B = 0x5b000002;
const THIRD = 0x0c0ffee5;
const SOURCE_C = 'rt-xs-src-c';
const MC_A = 'rt-xs-mc-a';
const MC_B = 'rt-xs-mc-b';

// Genuinely Ed25519-signed flood advert (from coverageMeshCore.test.ts).
const GOLDEN_PUBLIC_KEY = 'f3d220dfe9d16abbbe18c13906206cfa4d39e3f37c0b5241d08db75a375050f0';
const GOLDEN_FLOOD_RAW_HEX =
  '1142aabbccddf3d220dfe9d16abbbe18c13906206cfa4d39e3f37c0b5241d08db75a375050f0e0a1d36846b1826a94a718e0fd961682e4642dffce38f8593e7c9d949a461bd100871ad0bd6e86240be715d5035463db80472a35c2d02a2cf465c988a4942f1f884ed50790346640023807b4f8476f6c64656e4e6f6465';

describe('GET /api/unified/packets — cross-source correlation (#5559)', () => {
  let harness: RouteTestHarness;
  const t0 = Date.now() - 60_000;

  async function pkt(sourceId: string, overrides: Record<string, unknown>, offsetMs: number) {
    await harness.db.packetLog.insertPacketLog({
      packet_id: Math.floor(Math.random() * 1e9),
      timestamp: t0 + offsetMs,
      from_node: THIRD,
      to_node: 0xffffffff,
      channel: 0,
      portnum: 3,
      encrypted: true, // encrypted rows skip the channel-read gate; this suite is about source gates
      direction: 'rx',
      transport_mechanism: 1,
      ...overrides,
    } as any, sourceId);
  }

  beforeEach(async () => {
    harness = await createRouteTestApp({
      useOptionalAuth: false,
      mount: (app) => app.use('/api/unified', unifiedRoutes),
    });
    await harness.db.sources.createSource({ id: SOURCE_C, name: 'Source C', type: 'meshtastic_tcp', config: {} } as any);
    await harness.db.settings.setSetting(localNodeNumSettingKey(harness.sourceA), String(NUM_A));
    await harness.db.settings.setSetting(localNodeNumSettingKey(harness.sourceB), String(NUM_B));

    // On B: one packet from A (origin), one relayed by A (likely relay), one plain.
    await pkt(harness.sourceB, { from_node: NUM_A, hop_start: 3, hop_limit: 3, relay_node: NUM_A & 0xff }, 1000);
    await pkt(harness.sourceB, { from_node: THIRD, hop_start: 3, hop_limit: 1, relay_node: NUM_A & 0xff }, 2000);
    await pkt(harness.sourceB, { from_node: THIRD, hop_start: 3, hop_limit: 3, relay_node: THIRD & 0xff }, 3000);
    // On C (never granted to the limited user): a packet from A over MQTT.
    await pkt(SOURCE_C, { from_node: NUM_A, transport_mechanism: 5 }, 4000);
  });

  afterEach(async () => {
    for (const id of [harness.sourceA, harness.sourceB, SOURCE_C, MC_A, MC_B]) {
      await harness.db.packetLog.clearPacketLogs(id).catch(() => {});
      await harness.db.meshcore.deleteAllPackets(id).catch(() => {});
      await harness.db.settings.setSetting(localNodeNumSettingKey(id), '').catch(() => {});
    }
    await harness.db.meshcore.deleteNode(GOLDEN_PUBLIC_KEY, MC_A).catch(() => {});
    for (const id of [SOURCE_C, MC_A, MC_B]) await harness.db.sources.deleteSource(id).catch(() => {});
    await harness.cleanup();
  });

  const byFrom = (packets: any[], sourceId: string, from: number, hopLimit?: number) =>
    packets.find((p) => p.sourceId === sourceId && p.from_node === from && (hopLimit === undefined || p.hop_limit === hopLimit));

  it('admin: origin and likely-relay tags with transport', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/api/unified/packets?limit=50');
    expect(res.status).toBe(200);

    const origin = byFrom(res.body.packets, harness.sourceB, NUM_A);
    expect(origin).toMatchObject({
      originSourceId: harness.sourceA,
      originSourceName: expect.any(String),
      likelyRelaySourceId: null,
      crossSourceTransport: 'rf',
    });

    const relayed = byFrom(res.body.packets, harness.sourceB, THIRD, 1);
    expect(relayed).toMatchObject({
      originSourceId: null,
      likelyRelaySourceId: harness.sourceA,
      likelyRelayCandidateCount: 1,
      crossSourceTransport: 'rf',
    });

    const plain = byFrom(res.body.packets, harness.sourceB, THIRD, 3);
    expect(plain).toMatchObject({ originSourceId: null, likelyRelaySourceId: null, crossSourceTransport: null });

    const viaMqtt = byFrom(res.body.packets, SOURCE_C, NUM_A);
    expect(viaMqtt).toMatchObject({ originSourceId: harness.sourceA, crossSourceTransport: 'mqtt' });
  });

  it('crossSource filter keeps only matching rows', async () => {
    const agent = await harness.loginAs(harness.admin);
    const origin = await agent.get('/api/unified/packets?limit=50&crossSource=origin');
    expect(origin.status).toBe(200);
    expect(origin.body.packets.length).toBe(2);
    expect(origin.body.packets.every((p: any) => p.originSourceId === harness.sourceA)).toBe(true);

    const relay = await agent.get('/api/unified/packets?limit=50&crossSource=relay');
    expect(relay.body.packets.map((p: any) => p.likelyRelaySourceId)).toEqual([harness.sourceA]);

    const any = await agent.get('/api/unified/packets?limit=50&crossSource=any');
    expect(any.body.packets.length).toBe(3);
    expect(any.body.hasMore).toBe(false);
  });

  it('crossSource filter pages without skipping rows', async () => {
    const agent = await harness.loginAs(harness.admin);
    const first = await agent.get('/api/unified/packets?limit=1&crossSource=any');
    const seen = [...first.body.packets];
    let cursor = first.body.nextCursor;
    for (let i = 0; i < 10 && cursor; i++) {
      const next = await agent.get(`/api/unified/packets?limit=1&crossSource=any&cursor=${cursor}`);
      seen.push(...next.body.packets);
      cursor = next.body.nextCursor;
    }
    expect(seen.length).toBe(3);
  });

  it('rejects an unknown crossSource value', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/api/unified/packets?crossSource=bogus');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CROSS_SOURCE');
  });

  it('a user who can read only B sees no tags and never learns A exists', async () => {
    await harness.grant(harness.limited.id, 'packetmonitor', 'read', harness.sourceB);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/api/unified/packets?limit=50');
    expect(res.status).toBe(200);
    expect(res.body.packets.length).toBe(3);
    for (const p of res.body.packets) {
      expect(p.sourceId).toBe(harness.sourceB);
      expect(p.originSourceId).toBeNull();
      expect(p.likelyRelaySourceId).toBeNull();
      expect(p.crossSourceTransport).toBeNull();
    }
    expect(JSON.stringify(res.body)).not.toContain(harness.sourceA);

    const filtered = await agent.get('/api/unified/packets?limit=50&crossSource=any');
    expect(filtered.body.packets).toEqual([]);
  });

  it('a user who can read A and B sees the tags, but not rows from unreadable C', async () => {
    await harness.grant(harness.limited.id, 'packetmonitor', 'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'packetmonitor', 'read', harness.sourceB);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/api/unified/packets?limit=50');
    expect(byFrom(res.body.packets, harness.sourceB, NUM_A)?.originSourceId).toBe(harness.sourceA);
    expect(res.body.packets.some((p: any) => p.sourceId === SOURCE_C)).toBe(false);
  });

  it('MeshCore: a verified advert from source MC_A heard by MC_B is tagged origin', async () => {
    await harness.db.sources.createSource({ id: MC_A, name: 'MC A', type: 'meshcore', config: {} } as any);
    await harness.db.sources.createSource({ id: MC_B, name: 'MC B', type: 'meshcore', config: {} } as any);
    await harness.db.meshcore.upsertNode({ publicKey: GOLDEN_PUBLIC_KEY, name: 'A', isLocalNode: true } as any, MC_A);
    await harness.db.meshcore.insertPacket({
      sourceId: MC_B, timestamp: t0 + 5000, payloadType: 4, payloadTypeName: 'ADVERT', routeType: 1,
      snr: 5, rssi: -70, payloadSize: 120, rawHex: GOLDEN_FLOOD_RAW_HEX, createdAt: t0 + 5000,
    } as any);

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/api/unified/packets?limit=50');
    const mc = res.body.packets.find((p: any) => p.sourceId === MC_B);
    expect(mc).toMatchObject({ originSourceId: MC_A, crossSourceTransport: 'rf' });
  });
});
