/**
 * `trimPacketsToCount` retention boundary (#5040 Phase 2 review follow-up).
 *
 * The delete predicate has to mirror the survivor `ORDER BY` exactly. A bare
 * `id < oldestKeptId` assumes ids rise with timestamps — true while both write
 * paths stamp `Date.now()` at insert, false after a backwards clock step, and
 * the failure is silent: the log simply grows past its configured cap.
 *
 * This matters more for a `meshcore_mqtt` source than a device one, since a
 * region feed writes many rows per second and leans on the cap for its disk
 * bound.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { MeshCoreRepository, type DbMeshCorePacket } from './meshcore.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

function packet(over: Partial<DbMeshCorePacket> = {}): DbMeshCorePacket {
  return {
    sourceId: 'src-mqtt',
    timestamp: 1000,
    payloadType: 2,
    rawHex: 'aa',
    createdAt: 1000,
    ...over,
  };
}

describe('trimPacketsToCount — retention boundary', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: MeshCoreRepository;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    repo = new MeshCoreRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => db.close());

  it('trims to exactly maxCount when every row shares one timestamp', async () => {
    // A region feed writes a burst of observer receptions within the same
    // millisecond, so this is the common case, not an edge case.
    for (let i = 0; i < 10; i++) await repo.insertPacket(packet({ timestamp: 5000 }));

    await repo.trimPacketsToCount('src-mqtt', 4);
    expect(await repo.getPacketCount({ sourceId: 'src-mqtt' })).toBe(4);
  });

  it('trims to exactly maxCount when a high-id row carries an OLD timestamp', async () => {
    // The regression: a backwards clock step (NTP) inserts a row whose id is
    // highest but whose timestamp is oldest. Under `id < oldestKeptId` it fell
    // out of the survivor set AND escaped the delete — a trim to 3 left 4.
    for (let i = 0; i < 5; i++) await repo.insertPacket(packet({ timestamp: 1000 + i }));
    await repo.insertPacket(packet({ timestamp: 1 }));

    await repo.trimPacketsToCount('src-mqtt', 3);
    expect(await repo.getPacketCount({ sourceId: 'src-mqtt' })).toBe(3);
  });

  it('keeps the NEWEST rows, not an arbitrary subset', async () => {
    for (let i = 0; i < 6; i++) await repo.insertPacket(packet({ timestamp: 100 + i }));

    await repo.trimPacketsToCount('src-mqtt', 2);
    const remaining = await repo.getPackets({ sourceId: 'src-mqtt', limit: 10 });
    expect(remaining.map((r) => r.timestamp)).toEqual([105, 104]);
  });

  it('never trims another source', async () => {
    for (let i = 0; i < 5; i++) await repo.insertPacket(packet({ sourceId: 'src-a', timestamp: 100 + i }));
    for (let i = 0; i < 5; i++) await repo.insertPacket(packet({ sourceId: 'src-b', timestamp: 100 + i }));

    await repo.trimPacketsToCount('src-a', 1);
    expect(await repo.getPacketCount({ sourceId: 'src-a' })).toBe(1);
    expect(await repo.getPacketCount({ sourceId: 'src-b' })).toBe(5);
  });

  it('is a no-op when the log is already under the cap', async () => {
    await repo.insertPacket(packet());
    expect(await repo.trimPacketsToCount('src-mqtt', 10)).toBe(0);
    expect(await repo.getPacketCount({ sourceId: 'src-mqtt' })).toBe(1);
  });
});
