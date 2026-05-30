/**
 * MeshCore Packet Log Repository — per-source isolation tests.
 *
 * The `meshcore_packet_log` table (migration 075) carries a `sourceId` on
 * every row. These tests assert that queries, counts, retention trimming and
 * clears never leak across sources.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { MeshCoreRepository, type DbMeshCorePacket } from './meshcore.js';
import * as schema from '../schema/index.js';

function makePacket(sourceId: string, overrides: Partial<DbMeshCorePacket> = {}): DbMeshCorePacket {
  const now = 1_700_000_000_000;
  return {
    sourceId,
    timestamp: now,
    payloadType: 0x02,
    payloadTypeName: 'TXT_MSG',
    routeType: 0x01,
    routeTypeName: 'FLOOD',
    pathLenRaw: 0x41,
    hopCount: 1,
    pathHops: 'a3',
    snr: 6.25,
    rssi: -42,
    payloadSize: 24,
    rawHex: 'deadbeef',
    createdAt: now,
    ...overrides,
  };
}

describe('MeshCoreRepository — packet-log per-source isolation', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: MeshCoreRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    // Mirror migration 075 (SQLite).
    db.exec(`
      CREATE TABLE meshcore_packet_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sourceId TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        payloadType INTEGER NOT NULL,
        payloadTypeName TEXT,
        routeType INTEGER,
        routeTypeName TEXT,
        pathLenRaw INTEGER,
        hopCount INTEGER,
        pathHops TEXT,
        snr REAL,
        rssi INTEGER,
        payloadSize INTEGER,
        rawHex TEXT,
        createdAt INTEGER NOT NULL
      );
    `);
    drizzleDb = drizzle(db, { schema });
    repo = new MeshCoreRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  it('insertPacket requires a sourceId', async () => {
    await expect(repo.insertPacket(makePacket(''))).rejects.toThrow(/sourceId/);
  });

  it('getPackets and getPacketCount scope by sourceId', async () => {
    await repo.insertPacket(makePacket('src-a', { timestamp: 100 }));
    await repo.insertPacket(makePacket('src-a', { timestamp: 200 }));
    await repo.insertPacket(makePacket('src-b', { timestamp: 300 }));

    const aPackets = await repo.getPackets({ sourceId: 'src-a' });
    expect(aPackets).toHaveLength(2);
    expect(aPackets.every(p => p.sourceId === 'src-a')).toBe(true);

    expect(await repo.getPacketCount({ sourceId: 'src-a' })).toBe(2);
    expect(await repo.getPacketCount({ sourceId: 'src-b' })).toBe(1);
  });

  it('getPackets returns newest first and honours limit/offset', async () => {
    for (let i = 0; i < 5; i++) {
      await repo.insertPacket(makePacket('src-a', { timestamp: 100 + i }));
    }
    const firstPage = await repo.getPackets({ sourceId: 'src-a', limit: 2 });
    expect(firstPage.map(p => p.timestamp)).toEqual([104, 103]);
    const secondPage = await repo.getPackets({ sourceId: 'src-a', limit: 2, offset: 2 });
    expect(secondPage.map(p => p.timestamp)).toEqual([102, 101]);
  });

  it('filters by payloadType and routeType', async () => {
    await repo.insertPacket(makePacket('src-a', { payloadType: 0x02, routeType: 0x01 }));
    await repo.insertPacket(makePacket('src-a', { payloadType: 0x04, routeType: 0x02 }));

    expect(await repo.getPacketCount({ sourceId: 'src-a', payloadType: 0x04 })).toBe(1);
    expect(await repo.getPacketCount({ sourceId: 'src-a', routeType: 0x02 })).toBe(1);
    const advert = await repo.getPackets({ sourceId: 'src-a', payloadType: 0x04 });
    expect(advert[0].routeType).toBe(0x02);
  });

  it('filters by since timestamp', async () => {
    await repo.insertPacket(makePacket('src-a', { timestamp: 100 }));
    await repo.insertPacket(makePacket('src-a', { timestamp: 500 }));
    expect(await repo.getPacketCount({ sourceId: 'src-a', since: 300 })).toBe(1);
  });

  it('deletePacketsOlderThan removes only old rows', async () => {
    await repo.insertPacket(makePacket('src-a', { timestamp: 100 }));
    await repo.insertPacket(makePacket('src-a', { timestamp: 500 }));
    const removed = await repo.deletePacketsOlderThan(300);
    expect(removed).toBe(1);
    expect(await repo.getPacketCount({ sourceId: 'src-a' })).toBe(1);
  });

  it('trimPacketsToCount keeps the newest N rows for a source', async () => {
    for (let i = 0; i < 10; i++) {
      await repo.insertPacket(makePacket('src-a', { timestamp: 100 + i }));
    }
    await repo.insertPacket(makePacket('src-b', { timestamp: 999 }));

    const removed = await repo.trimPacketsToCount('src-a', 3);
    expect(removed).toBe(7);

    const remaining = await repo.getPackets({ sourceId: 'src-a' });
    expect(remaining.map(p => p.timestamp)).toEqual([109, 108, 107]);
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
