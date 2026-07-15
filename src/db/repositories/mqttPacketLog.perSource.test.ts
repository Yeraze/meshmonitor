/**
 * MQTT Packet Log Repository — per-source isolation tests.
 *
 * The `mqtt_packet_log` table (migration 120) carries a `sourceId` on every
 * row. These tests assert that every query, count, retention operation, and
 * clear never leaks across sources.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { MqttPacketLogRepository, type DbMqttPacket } from './mqttPacketLog.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

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

describe('MqttPacketLogRepository — per-source isolation', () => {
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

  it('insertPacket requires a sourceId', async () => {
    await expect(repo.insertPacket(makePacket(''))).rejects.toThrow(/sourceId/);
  });

  it('getGroupedPackets scopes by sourceId', async () => {
    await repo.insertPacket(makePacket('src-a', { packetId: 1, fromNode: 10, timestamp: 100 }));
    await repo.insertPacket(makePacket('src-a', { packetId: 2, fromNode: 10, timestamp: 200 }));
    await repo.insertPacket(makePacket('src-b', { packetId: 3, fromNode: 10, timestamp: 300 }));

    const aGroups = await repo.getGroupedPackets({ sourceId: 'src-a' });
    expect(aGroups).toHaveLength(2);
    const bGroups = await repo.getGroupedPackets({ sourceId: 'src-b' });
    expect(bGroups).toHaveLength(1);
    expect(bGroups[0].packetId).toBe(3);
  });

  it('getGroupedPacketCount scopes by sourceId', async () => {
    await repo.insertPacket(makePacket('src-a', { packetId: 1, fromNode: 10 }));
    await repo.insertPacket(makePacket('src-a', { packetId: 2, fromNode: 10 }));
    await repo.insertPacket(makePacket('src-b', { packetId: 1, fromNode: 10 }));

    expect(await repo.getGroupedPacketCount({ sourceId: 'src-a' })).toBe(2);
    expect(await repo.getGroupedPacketCount({ sourceId: 'src-b' })).toBe(1);
  });

  it('getReceptions scopes by sourceId', async () => {
    await repo.insertPacket(makePacket('src-a', { packetId: 42, fromNode: 10, gatewayId: '!aaaaaaaa' }));
    await repo.insertPacket(makePacket('src-b', { packetId: 42, fromNode: 10, gatewayId: '!bbbbbbbb' }));

    const aReceptions = await repo.getReceptions('src-a', 42, 10);
    expect(aReceptions).toHaveLength(1);
    expect(aReceptions[0].gatewayId).toBe('!aaaaaaaa');

    const bReceptions = await repo.getReceptions('src-b', 42, 10);
    expect(bReceptions).toHaveLength(1);
    expect(bReceptions[0].gatewayId).toBe('!bbbbbbbb');
  });

  it('getGateways scopes by sourceId', async () => {
    await repo.insertPacket(makePacket('src-a', { gatewayId: '!aaaaaaaa' }));
    await repo.insertPacket(makePacket('src-a', { gatewayId: '!bbbbbbbb' }));
    await repo.insertPacket(makePacket('src-b', { gatewayId: '!cccccccc' }));

    const aGateways = await repo.getGateways('src-a');
    expect(aGateways.map(g => g.gatewayId).sort()).toEqual(['!aaaaaaaa', '!bbbbbbbb']);

    const bGateways = await repo.getGateways('src-b');
    expect(bGateways.map(g => g.gatewayId)).toEqual(['!cccccccc']);
  });

  it('getPacketCount scopes by sourceId', async () => {
    await repo.insertPacket(makePacket('src-a'));
    await repo.insertPacket(makePacket('src-a'));
    await repo.insertPacket(makePacket('src-b'));

    expect(await repo.getPacketCount({ sourceId: 'src-a' })).toBe(2);
    expect(await repo.getPacketCount({ sourceId: 'src-b' })).toBe(1);
    expect(await repo.getPacketCount()).toBe(3);
  });

  it('deletePacketsOlderThan is source-scoped when a sourceId is given', async () => {
    await repo.insertPacket(makePacket('src-a', { timestamp: 100 }));
    await repo.insertPacket(makePacket('src-a', { timestamp: 500 }));
    await repo.insertPacket(makePacket('src-b', { timestamp: 100 }));

    const removed = await repo.deletePacketsOlderThan(300, 'src-a');
    expect(removed).toBe(1);
    expect(await repo.getPacketCount({ sourceId: 'src-a' })).toBe(1);
    // src-b untouched despite being older than the cutoff.
    expect(await repo.getPacketCount({ sourceId: 'src-b' })).toBe(1);
  });

  it('trimPacketsToCount keeps the newest N rows for a source only', async () => {
    for (let i = 0; i < 10; i++) {
      await repo.insertPacket(makePacket('src-a', { timestamp: 100 + i, packetId: i }));
    }
    await repo.insertPacket(makePacket('src-b', { timestamp: 999, packetId: 999 }));

    const removed = await repo.trimPacketsToCount('src-a', 3);
    expect(removed).toBe(7);

    expect(await repo.getPacketCount({ sourceId: 'src-a' })).toBe(3);
    // src-b untouched.
    expect(await repo.getPacketCount({ sourceId: 'src-b' })).toBe(1);
  });

  it('deleteAllPackets is source-scoped', async () => {
    await repo.insertPacket(makePacket('src-a'));
    await repo.insertPacket(makePacket('src-a'));
    await repo.insertPacket(makePacket('src-b'));

    const removed = await repo.deleteAllPackets('src-a');
    expect(removed).toBe(2);
    expect(await repo.getPacketCount({ sourceId: 'src-a' })).toBe(0);
    expect(await repo.getPacketCount({ sourceId: 'src-b' })).toBe(1);
  });

  it('getPacketLogSourceIds returns distinct sources', async () => {
    await repo.insertPacket(makePacket('src-a'));
    await repo.insertPacket(makePacket('src-a'));
    await repo.insertPacket(makePacket('src-b'));
    const ids = (await repo.getPacketLogSourceIds()).sort();
    expect(ids).toEqual(['src-a', 'src-b']);
  });
});
