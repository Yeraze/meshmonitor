/**
 * `#5101` packet_log transport class filter — per-source isolation.
 *
 * `getPacketLogCount` (via `buildPacketLogWhere`), `getPacketCountsByNode`
 * and `getPacketCountsByPortnum` all take `transportClass` alongside
 * `sourceId`. This asserts none of the three leaks another source's rows
 * when both filters are combined — a class filter alone must never widen
 * the source scope.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { PacketLogRepository } from './packetLog.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';
import { PortNum, TransportMechanism } from '../../server/constants/meshtastic.js';
import type { DbPacketLog } from '../types.js';

const SOURCE_A = 'src-a';
const SOURCE_B = 'src-b';
const NOW = 1_760_000_000_000;

function makePacket(
  sourceId: string,
  fromNode: number,
  packetId: number,
  mechanism: number,
): Omit<DbPacketLog, 'id' | 'created_at'> {
  return {
    packet_id: packetId,
    timestamp: NOW,
    from_node: fromNode,
    to_node: 4294967295,
    portnum: PortNum.TEXT_MESSAGE_APP,
    portnum_name: 'TEXT_MESSAGE_APP',
    encrypted: false,
    direction: 'rx',
    transport_mechanism: mechanism,
    sourceId,
  };
}

describe('PacketLogRepository transport class filter - per-source isolation', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: PacketLogRepository;

  beforeEach(async () => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    repo = new PacketLogRepository(drizzleDb as any, 'sqlite');

    // Mirrored rows across two sources: same from_node/packet_id numbers, one
    // MQTT row and one UDP row per source.
    await repo.insertPacketLog(makePacket(SOURCE_A, 100, 1, TransportMechanism.MQTT), SOURCE_A);
    await repo.insertPacketLog(makePacket(SOURCE_A, 101, 2, TransportMechanism.MULTICAST_UDP), SOURCE_A);
    await repo.insertPacketLog(makePacket(SOURCE_B, 100, 1, TransportMechanism.MQTT), SOURCE_B);
    await repo.insertPacketLog(makePacket(SOURCE_B, 101, 2, TransportMechanism.MULTICAST_UDP), SOURCE_B);
  });

  afterEach(() => {
    db.close();
  });

  it('getPacketLogCount scopes transportClass by sourceId', async () => {
    expect(await repo.getPacketLogCount({ sourceId: SOURCE_A, transportClass: 'mqtt' })).toBe(1);
    expect(await repo.getPacketLogCount({ sourceId: SOURCE_B, transportClass: 'mqtt' })).toBe(1);
    expect(await repo.getPacketLogCount({ transportClass: 'mqtt' })).toBe(2);
  });

  it('getPacketCountsByNode never returns the other source\'s rows for a transportClass', async () => {
    const aRows = await repo.getPacketCountsByNode({ sourceId: SOURCE_A, transportClass: 'mqtt', limit: 100 });
    expect(aRows).toHaveLength(1);
    expect(aRows[0].from_node).toBe(100);

    const bRows = await repo.getPacketCountsByNode({ sourceId: SOURCE_B, transportClass: 'udp', limit: 100 });
    expect(bRows).toHaveLength(1);
    expect(bRows[0].from_node).toBe(101);
  });

  it('getPacketCountsByPortnum never returns the other source\'s rows for a transportClass', async () => {
    const aRows = await repo.getPacketCountsByPortnum({ sourceId: SOURCE_A, transportClass: 'udp' });
    expect(aRows).toHaveLength(1);
    expect(aRows[0].count).toBe(1);

    const bRows = await repo.getPacketCountsByPortnum({ sourceId: SOURCE_B, transportClass: 'mqtt' });
    expect(bRows).toHaveLength(1);
    expect(bRows[0].count).toBe(1);
  });

  it('rf class excludes the other source\'s mqtt/udp rows and includes only this source\'s rf rows', async () => {
    await repo.insertPacketLog(makePacket(SOURCE_A, 102, 3, TransportMechanism.LORA), SOURCE_A);
    expect(await repo.getPacketLogCount({ sourceId: SOURCE_A, transportClass: 'rf' })).toBe(1);
    expect(await repo.getPacketLogCount({ sourceId: SOURCE_B, transportClass: 'rf' })).toBe(0);
  });
});
