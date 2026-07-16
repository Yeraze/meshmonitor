/**
 * MQTT Packet Log Repository — grouped-query correctness tests.
 *
 * `mqtt_packet_log` is a reception log (one row per gateway copy of an
 * MQTT-bridged packet). `getGroupedPackets`/`getGroupedPacketCount` collapse
 * receptions into one row per `(sourceId, fromNode, packetId)` group, with a
 * `COALESCE(NULLIF(packetId,0), -id)` fallback key for the 0/null packetId
 * edge case. See MQTT_PACKET_MONITOR_PHASE1_SPEC.md §3/§4.3.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { MqttPacketLogRepository, type DbMqttPacket } from './mqttPacketLog.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const SOURCE = 'src-a';

function makePacket(overrides: Partial<DbMqttPacket> = {}): DbMqttPacket {
  const now = 1_700_000_000_000;
  return {
    sourceId: SOURCE,
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

describe('MqttPacketLogRepository — grouped query correctness', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: MqttPacketLogRepository;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    repo = new MqttPacketLogRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  it('collapses multiple gateway receptions of the same packet into one group', async () => {
    await repo.insertPacket(makePacket({
      packetId: 100, fromNode: 111, gatewayId: '!gw000001', timestamp: 1000, rxSnr: 5.0,
    }));
    await repo.insertPacket(makePacket({
      packetId: 100, fromNode: 111, gatewayId: '!gw000002', timestamp: 2000, rxSnr: 6.0,
    }));
    await repo.insertPacket(makePacket({
      packetId: 100, fromNode: 111, gatewayId: '!gw000003', timestamp: 3000, rxSnr: 4.0,
    }));

    const groups = await repo.getGroupedPackets({ sourceId: SOURCE });
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.packetId).toBe(100);
    expect(g.fromNode).toBe(111);
    expect(g.gatewayCount).toBe(3);
    expect(g.receptionCount).toBe(3);
    expect(g.firstHeard).toBe(1000);
    expect(g.lastHeard).toBe(3000);
    expect(g.portnumName).toBe('TEXT_MESSAGE_APP');
    expect(g.channelId).toBe('LongFast');
  });

  it('keeps distinct packets from the same fromNode as separate groups', async () => {
    await repo.insertPacket(makePacket({ packetId: 100, fromNode: 111, timestamp: 1000 }));
    await repo.insertPacket(makePacket({ packetId: 101, fromNode: 111, timestamp: 2000 }));

    const groups = await repo.getGroupedPackets({ sourceId: SOURCE });
    expect(groups).toHaveLength(2);
    expect(groups.map(g => g.packetId).sort()).toEqual([100, 101]);
  });

  it('gateway filter narrows both the returned groups and the gatewayCount', async () => {
    // Packet 100 heard by gw1 and gw2.
    await repo.insertPacket(makePacket({
      packetId: 100, fromNode: 111, gatewayId: '!gw000001', timestamp: 1000,
    }));
    await repo.insertPacket(makePacket({
      packetId: 100, fromNode: 111, gatewayId: '!gw000002', timestamp: 2000,
    }));
    // Packet 200 heard only by gw2.
    await repo.insertPacket(makePacket({
      packetId: 200, fromNode: 111, gatewayId: '!gw000002', timestamp: 3000,
    }));

    const filtered = await repo.getGroupedPackets({ sourceId: SOURCE, gateways: ['!gw000001'] });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].packetId).toBe(100);
    expect(filtered[0].gatewayCount).toBe(1);
    // Packet 200 (heard only by gw2) is absent when filtering to gw1.
    expect(filtered.some(g => g.packetId === 200)).toBe(false);
  });

  it('portnum filter narrows the group set', async () => {
    await repo.insertPacket(makePacket({ packetId: 100, fromNode: 111, portnum: 1 }));
    await repo.insertPacket(makePacket({ packetId: 101, fromNode: 111, portnum: 3, portnumName: 'POSITION_APP' }));

    const groups = await repo.getGroupedPackets({ sourceId: SOURCE, portnum: 3 });
    expect(groups).toHaveLength(1);
    expect(groups[0].packetId).toBe(101);
  });

  it('since filter narrows the group set', async () => {
    await repo.insertPacket(makePacket({ packetId: 100, fromNode: 111, timestamp: 1000 }));
    await repo.insertPacket(makePacket({ packetId: 101, fromNode: 111, timestamp: 5000 }));

    const groups = await repo.getGroupedPackets({ sourceId: SOURCE, since: 3000 });
    expect(groups).toHaveLength(1);
    expect(groups[0].packetId).toBe(101);
  });

  it('encrypted filter narrows the group set', async () => {
    await repo.insertPacket(makePacket({ packetId: 100, fromNode: 111, encrypted: 0 }));
    await repo.insertPacket(makePacket({ packetId: 101, fromNode: 112, encrypted: 1, portnum: null, portnumName: null }));

    const encryptedOnly = await repo.getGroupedPackets({ sourceId: SOURCE, encrypted: true });
    expect(encryptedOnly).toHaveLength(1);
    expect(encryptedOnly[0].packetId).toBe(101);
    expect(encryptedOnly[0].encrypted).toBe(1);

    const plainOnly = await repo.getGroupedPackets({ sourceId: SOURCE, encrypted: false });
    expect(plainOnly).toHaveLength(1);
    expect(plainOnly[0].packetId).toBe(100);
  });

  it('packetId 0/null rows each become their own singleton group', async () => {
    // Three rows with packetId=0, three with packetId=null, all same fromNode.
    for (let i = 0; i < 3; i++) {
      await repo.insertPacket(makePacket({ packetId: 0, fromNode: 200, gatewayId: `!zero0000${i}`, timestamp: 1000 + i }));
    }
    for (let i = 0; i < 3; i++) {
      await repo.insertPacket(makePacket({ packetId: null, fromNode: 200, gatewayId: `!null0000${i}`, timestamp: 2000 + i }));
    }

    const groups = await repo.getGroupedPackets({ sourceId: SOURCE, limit: 100 });
    // They do NOT collapse into one group per packetId=0/null bucket.
    expect(groups).toHaveLength(6);
    for (const g of groups) {
      expect(g.gatewayCount).toBe(1);
      expect(g.receptionCount).toBe(1);
    }

    const count = await repo.getGroupedPacketCount({ sourceId: SOURCE });
    expect(count).toBe(groups.length);
  });

  it('getGroupedPacketCount matches the number of groups getGroupedPackets returns', async () => {
    await repo.insertPacket(makePacket({ packetId: 100, fromNode: 111, gatewayId: '!gw000001' }));
    await repo.insertPacket(makePacket({ packetId: 100, fromNode: 111, gatewayId: '!gw000002' }));
    await repo.insertPacket(makePacket({ packetId: 101, fromNode: 112, gatewayId: '!gw000001' }));

    const groups = await repo.getGroupedPackets({ sourceId: SOURCE });
    const count = await repo.getGroupedPacketCount({ sourceId: SOURCE });
    expect(count).toBe(groups.length);
    expect(count).toBe(2);
  });

  it('getGateways returns distinct gateways with correct receptionCount, lastHeard, and parsed gatewayNodeNum', async () => {
    await repo.insertPacket(makePacket({
      packetId: 100, fromNode: 111, gatewayId: '!aabbccdd', gatewayNodeNum: 0xaabbccdd, timestamp: 1000,
    }));
    await repo.insertPacket(makePacket({
      packetId: 101, fromNode: 111, gatewayId: '!aabbccdd', gatewayNodeNum: 0xaabbccdd, timestamp: 2000,
    }));
    await repo.insertPacket(makePacket({
      packetId: 102, fromNode: 112, gatewayId: '!11223344', gatewayNodeNum: 0x11223344, timestamp: 1500,
    }));

    const gateways = await repo.getGateways(SOURCE);
    expect(gateways).toHaveLength(2);

    const gw1 = gateways.find(g => g.gatewayId === '!aabbccdd');
    expect(gw1).toBeDefined();
    expect(gw1?.receptionCount).toBe(2);
    expect(gw1?.lastHeard).toBe(2000);
    expect(gw1?.gatewayNodeNum).toBe(0xaabbccdd);

    const gw2 = gateways.find(g => g.gatewayId === '!11223344');
    expect(gw2).toBeDefined();
    expect(gw2?.receptionCount).toBe(1);
    expect(gw2?.lastHeard).toBe(1500);
    expect(gw2?.gatewayNodeNum).toBe(0x11223344);
  });

  it('normalizeBigInts returns JS numbers for packetId/fromNode/gatewayNodeNum/timestamps', async () => {
    await repo.insertPacket(makePacket({
      packetId: 100, fromNode: 111, gatewayId: '!aabbccdd', gatewayNodeNum: 0xaabbccdd, timestamp: 1000,
    }));

    const groups = await repo.getGroupedPackets({ sourceId: SOURCE });
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(typeof g.packetId).toBe('number');
    expect(typeof g.fromNode).toBe('number');
    expect(typeof g.firstHeard).toBe('number');
    expect(typeof g.lastHeard).toBe('number');
    expect(typeof g.gatewayCount).toBe('number');
    expect(typeof g.receptionCount).toBe('number');

    const gateways = await repo.getGateways(SOURCE);
    expect(typeof gateways[0].gatewayNodeNum).toBe('number');
    expect(typeof gateways[0].lastHeard).toBe('number');

    const receptions = await repo.getReceptions(SOURCE, 100, 111);
    expect(typeof receptions[0].packetId).toBe('number');
    expect(typeof receptions[0].fromNode).toBe('number');
    expect(typeof receptions[0].timestamp).toBe('number');
  });
});
