/**
 * `GET /api/packets/stats/distribution` transport filter (#5101).
 *
 * `?transport=all|rf|udp|mqtt` filters `byDevice`, `byType` and `total`
 * together (they share the new `transportConditions` helper in
 * `packetLog.ts`). Uses the real-middleware harness (`createRouteTestApp`)
 * so `requirePacketPermissions` and `packetmonitor:read` are exercised with
 * real SQL rather than a hand-rolled permission lambda.
 *
 * The harness's singleton DB is NOT cleared between files, so inserted rows
 * are deleted per-source in `afterEach`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import packetRoutes from './packetRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { PortNum, TransportMechanism } from '../constants/meshtastic.js';
import type { DbPacketLog } from '../../db/types.js';

describe('GET /api/packets/stats/distribution - transport filter', () => {
  let harness: RouteTestHarness;

  async function seedPacket(sourceId: string, fromNode: number, packetId: number, mechanism: number) {
    const packet: Omit<DbPacketLog, 'id' | 'created_at'> = {
      packet_id: packetId,
      timestamp: Date.now(),
      from_node: fromNode,
      to_node: 4294967295,
      portnum: PortNum.TEXT_MESSAGE_APP,
      portnum_name: 'TEXT_MESSAGE_APP',
      encrypted: false,
      direction: 'rx',
      transport_mechanism: mechanism,
      sourceId,
    };
    await harness.db.insertPacketLogAsync(packet);
  }

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/api/packets', packetRoutes),
    });

    harness.db.setSetting('packet_log_enabled', '1');

    await harness.grant(harness.limited.id, 'packetmonitor', 'read', harness.sourceA);

    // sourceA: 1 MQTT, 1 UDP, 1 RF row. sourceB: 1 MQTT row (mirrored from_node
    // to make cross-source leakage detectable).
    await seedPacket(harness.sourceA, 100, 1, TransportMechanism.MQTT);
    await seedPacket(harness.sourceA, 101, 2, TransportMechanism.MULTICAST_UDP);
    await seedPacket(harness.sourceA, 102, 3, TransportMechanism.LORA);
    await seedPacket(harness.sourceB, 100, 1, TransportMechanism.MQTT);
  });

  afterEach(async () => {
    await harness.db.packetLog.clearPacketLogs(harness.sourceA);
    await harness.db.packetLog.clearPacketLogs(harness.sourceB);
    await harness.cleanup();
  });

  it('transport=mqtt returns only sourceA\'s MQTT rows in byDevice, byType and total', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/api/packets/stats/distribution?sourceId=${harness.sourceA}&transport=mqtt`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.byDevice).toHaveLength(1);
    expect(res.body.byDevice[0].from_node).toBe(100);
    expect(res.body.byType).toHaveLength(1);
    expect(res.body.byType[0].count).toBe(1);
  });

  it('transport=udp and transport=rf isolate their own single row each', async () => {
    const agent = await harness.loginAs(harness.admin);

    const udpRes = await agent.get(`/api/packets/stats/distribution?sourceId=${harness.sourceA}&transport=udp`);
    expect(udpRes.body.total).toBe(1);
    expect(udpRes.body.byDevice[0].from_node).toBe(101);

    const rfRes = await agent.get(`/api/packets/stats/distribution?sourceId=${harness.sourceA}&transport=rf`);
    expect(rfRes.body.total).toBe(1);
    expect(rfRes.body.byDevice[0].from_node).toBe(102);
  });

  it('transport=all and an absent transport param are identical', async () => {
    const agent = await harness.loginAs(harness.admin);

    const allRes = await agent.get(`/api/packets/stats/distribution?sourceId=${harness.sourceA}&transport=all`);
    const absentRes = await agent.get(`/api/packets/stats/distribution?sourceId=${harness.sourceA}`);

    expect(allRes.status).toBe(200);
    expect(absentRes.status).toBe(200);
    expect(allRes.body.total).toBe(3);
    expect(absentRes.body.total).toBe(3);
    expect(allRes.body).toEqual(absentRes.body);
  });

  it('transport=bogus returns 400 INVALID_TRANSPORT', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/api/packets/stats/distribution?sourceId=${harness.sourceA}&transport=bogus`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: 'INVALID_TRANSPORT' });
  });

  it('a limited user without packetmonitor:read on sourceB gets 403', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/api/packets/stats/distribution?sourceId=${harness.sourceB}&transport=mqtt`);

    expect(res.status).toBe(403);
  });

  it('the success body stays bare — byDevice/byType/total at the top level, not under data', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/api/packets/stats/distribution?sourceId=${harness.sourceA}&transport=mqtt`);

    expect(res.status).toBe(200);
    expect(res.body.data).toBeUndefined();
    expect(res.body).toHaveProperty('byDevice');
    expect(res.body).toHaveProperty('byType');
    expect(res.body).toHaveProperty('total');
    expect(res.body).toHaveProperty('enabled', true);
  });
});
