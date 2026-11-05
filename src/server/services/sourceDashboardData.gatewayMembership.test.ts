/**
 * buildSourceDashboard — gateway membership attachment (#6175, "colour nodes
 * by gateway").
 *
 * The membership rows ride the unified-dashboard bundle so the client can
 * colour/group nodes by the gateway that relayed them. They must appear ONLY
 * for an MQTT source, when the viewer can read that source's nodes, AND when
 * the MQTT packet log capture is enabled. A viewer lacking `nodes:read` on a
 * source must never learn which gateways it saw.
 *
 * Uses the real singleton DB (via createRouteTestApp's seeding, without
 * mounting a router — a service-level test) so the real settings / mqtt packet
 * log repositories and the real permission check are exercised end-to-end.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildSourceDashboard } from './sourceDashboardData.js';
import mqttPacketLogService from './mqttPacketLogService.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import type { DbMqttPacket } from '../../db/repositories/mqttPacketLog.js';
import type { User } from '../../types/auth.js';

// Recent so the rows fall inside buildSourceDashboard's default lookback window.
const NOW = Date.now();

function makePacket(sourceId: string, overrides: Partial<DbMqttPacket> = {}): DbMqttPacket {
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
    timestamp: NOW,
    rxTime: NOW,
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
    bitfield: null,
    okToMqttViolation: 0,
    topic: null,
    createdAt: NOW,
    ...overrides,
  };
}

describe('buildSourceDashboard — gateway membership (#6175)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: () => {} });
    await harness.db.settings.setSetting('mqtt_packet_log_enabled', '1');
    mqttPacketLogService.resetEnabledCache();
    // sourceA hears node 111 via two gateways; node 222 via one.
    await harness.db.mqttPacketLog.insertPacket(makePacket(harness.sourceA, { fromNode: 111, gatewayId: '!gw000001', gatewayNodeNum: 0x1, timestamp: NOW }));
    await harness.db.mqttPacketLog.insertPacket(makePacket(harness.sourceA, { fromNode: 111, gatewayId: '!gw000002', gatewayNodeNum: 0x2, timestamp: NOW + 1000 }));
    await harness.db.mqttPacketLog.insertPacket(makePacket(harness.sourceA, { fromNode: 222, gatewayId: '!gw000001', gatewayNodeNum: 0x1, timestamp: NOW }));
  });

  afterEach(async () => {
    await harness.db.mqttPacketLog.deleteAllPackets(harness.sourceA).catch(() => {});
    await harness.db.settings.setSetting('mqtt_packet_log_enabled', '0').catch(() => {});
    mqttPacketLogService.resetEnabledCache();
    await harness.cleanup();
  });

  const adminUser = () => harness.admin as unknown as User;
  const mqttSource = () => ({ id: harness.sourceA, name: 'Broker', type: 'mqtt_broker' });

  it('attaches gateway membership for an MQTT source the viewer can read', async () => {
    const payload = await buildSourceDashboard(mqttSource(), adminUser());
    expect(payload.gatewayMembership).toBeDefined();
    const node111 = payload.gatewayMembership!.filter((r) => r.fromNode === 111);
    expect(node111.map((r) => r.gatewayId).sort()).toEqual(['!gw000001', '!gw000002']);
    const node222 = payload.gatewayMembership!.filter((r) => r.fromNode === 222);
    expect(node222).toHaveLength(1);
  });

  it('omits gateway membership for a non-MQTT source', async () => {
    const payload = await buildSourceDashboard(
      { id: harness.sourceA, name: 'TCP', type: 'meshtastic_tcp' },
      adminUser(),
    );
    expect(payload.gatewayMembership).toBeUndefined();
  });

  it('omits gateway membership when the MQTT packet log is disabled', async () => {
    await harness.db.settings.setSetting('mqtt_packet_log_enabled', '0');
    mqttPacketLogService.resetEnabledCache();
    const payload = await buildSourceDashboard(mqttSource(), adminUser());
    // Service returns [] when disabled; the field is present but empty.
    expect(payload.gatewayMembership).toEqual([]);
  });

  it('never exposes a source\'s gateways to a viewer lacking nodes:read on it', async () => {
    // No grant for the limited user on sourceA → canReadNodes is false, so the
    // gateway read is skipped entirely (not just emptied).
    const payload = await buildSourceDashboard(mqttSource(), harness.limited as unknown as User);
    expect(payload.gatewayMembership).toBeUndefined();
  });

  it('attaches gateway membership once the viewer is granted nodes:read', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    const payload = await buildSourceDashboard(mqttSource(), harness.limited as unknown as User);
    expect(payload.gatewayMembership).toBeDefined();
    expect(payload.gatewayMembership!.length).toBeGreaterThan(0);
  });
});
