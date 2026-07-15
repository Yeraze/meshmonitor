/**
 * MQTT Packet Monitor Routes — per-source permission isolation tests.
 *
 * Uses the real-middleware harness (`createRouteTestApp`) rather than mocking
 * the DatabaseService singleton, so `requirePermission`/`checkPermissionAsync`
 * exercise real SQL. See `src/server/test-helpers/routeTestApp.ts` and the
 * canonical template `src/server/routes/sourceRoutes.permissions.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import mqttPacketRoutes from './mqttPacketRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import type { DbMqttPacket } from '../../db/repositories/mqttPacketLog.js';

function makePacket(sourceId: string, overrides: Partial<DbMqttPacket> = {}): DbMqttPacket {
  const now = 1_700_000_000_000;
  return {
    sourceId,
    packetId: 100,
    fromNode: 111,
    fromNodeId: '!0000006f',
    toNode: 0xffffffff,
    toNodeId: '!ffffffff',
    channel: 8,
    channelId: 'LongFast',
    gatewayId: '!aabbccdd',
    gatewayNodeNum: 0xaabbccdd,
    timestamp: now,
    rxTime: now,
    rxSnr: 5.5,
    rxRssi: -80,
    hopLimit: 3,
    hopStart: 3,
    portnum: 1,
    portnumName: 'TEXT_MESSAGE_APP',
    encrypted: 0,
    decryptedBy: null,
    ingestOutcome: 'ingested',
    payloadSize: 12,
    payloadPreview: 'hello',
    createdAt: now,
    ...overrides,
  };
}

describe('mqttPacketRoutes — per-source permission isolation', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/sources/:id/mqtt/packets', mqttPacketRoutes),
    });
  });

  afterEach(async () => {
    await harness.db.mqttPacketLog.deleteAllPackets(harness.sourceA).catch(() => {});
    await harness.db.mqttPacketLog.deleteAllPackets(harness.sourceB).catch(() => {});
    await harness.cleanup();
  });

  it('anonymous with no packetmonitor:read grant → denied on GET /', async () => {
    const agent = await harness.loginAs(null);
    const res = await agent.get(`/sources/${harness.sourceA}/mqtt/packets`);
    expect([401, 403]).toContain(res.status);
  });

  it('limited user without any grant → denied on GET /', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/sources/${harness.sourceA}/mqtt/packets`);
    expect(res.status).toBe(403);
  });

  describe('with packetmonitor:read granted on sourceA only', () => {
    beforeEach(async () => {
      await harness.grant(harness.limited.id, 'packetmonitor', 'read', harness.sourceA);
      await harness.db.mqttPacketLog.insertPacket(makePacket(harness.sourceA, { packetId: 1, fromNode: 1 }));
      await harness.db.mqttPacketLog.insertPacket(makePacket(harness.sourceB, { packetId: 2, fromNode: 2 }));
    });

    it('GET / on sourceA → 200 with success envelope, sees only sourceA rows', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/sources/${harness.sourceA}/mqtt/packets`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.packets).toHaveLength(1);
      expect(res.body.data.packets[0].fromNode).toBe(1);
      expect(res.body.data.total).toBe(1);
      expect(res.body.data).toHaveProperty('offset');
      expect(res.body.data).toHaveProperty('limit');
      expect(res.body.data).toHaveProperty('enabled');
      expect(res.body.data).toHaveProperty('maxCount');
      expect(res.body.data).toHaveProperty('maxAgeHours');
    });

    it('GET / on sourceB (no grant there) → denied — grant on sourceA does not open sourceB', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/sources/${harness.sourceB}/mqtt/packets`);
      expect(res.status).toBe(403);
    });

    it('GET /gateways on sourceA → 200 with success envelope', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/sources/${harness.sourceA}/mqtt/packets/gateways`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.gateways).toBeDefined();
      expect(Array.isArray(res.body.data.gateways)).toBe(true);
      expect(res.body.data.gateways.every((g: { gatewayId: string }) => g.gatewayId === '!aabbccdd')).toBe(true);
    });

    it('GET /receptions on sourceA with packetId+fromNode → 200 with success envelope', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/sources/${harness.sourceA}/mqtt/packets/receptions?packetId=1&fromNode=1`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.receptions).toHaveLength(1);
    });

    it('GET /receptions missing both params → 400 MISSING_PACKET_KEY', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/sources/${harness.sourceA}/mqtt/packets/receptions`);
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('MISSING_PACKET_KEY');
    });

    it('GET /receptions missing fromNode only → 400 MISSING_PACKET_KEY', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/sources/${harness.sourceA}/mqtt/packets/receptions?packetId=1`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('MISSING_PACKET_KEY');
    });

    it('GET /receptions missing packetId only → 400 MISSING_PACKET_KEY', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/sources/${harness.sourceA}/mqtt/packets/receptions?fromNode=1`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('MISSING_PACKET_KEY');
    });

    it('DELETE / without packetmonitor:write → denied', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.delete(`/sources/${harness.sourceA}/mqtt/packets`);
      expect(res.status).toBe(403);
    });
  });

  describe('with packetmonitor:write granted on sourceA', () => {
    beforeEach(async () => {
      await harness.grant(harness.limited.id, 'packetmonitor', 'write', harness.sourceA);
      await harness.db.mqttPacketLog.insertPacket(makePacket(harness.sourceA, { packetId: 1, fromNode: 1 }));
    });

    it('DELETE / succeeds, clears rows, and writes an audit row', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.delete(`/sources/${harness.sourceA}/mqtt/packets`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.deleted).toBe(1);

      const remaining = await harness.db.mqttPacketLog.getPacketCount({ sourceId: harness.sourceA });
      expect(remaining).toBe(0);

      const { logs } = await harness.db.getAuditLogsAsync({ action: 'mqtt_packets_cleared' });
      const match = logs.find((l: { userId: number | null; details: string | null }) => l.userId === harness.limited.id);
      expect(match).toBeDefined();
      const details = JSON.parse(match!.details as string);
      expect(details.sourceId).toBe(harness.sourceA);
      expect(details.deleted).toBe(1);
    });
  });

  it('admin bypasses grants entirely (real admin bypass)', async () => {
    await harness.db.mqttPacketLog.insertPacket(makePacket(harness.sourceA, { packetId: 5, fromNode: 5 }));
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/sources/${harness.sourceA}/mqtt/packets`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
