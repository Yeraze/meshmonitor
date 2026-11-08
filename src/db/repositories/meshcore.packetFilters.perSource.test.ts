/** Packet filters + distribution on SQLite, including per-source isolation (#6262). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { MeshCoreRepository } from './meshcore.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';
import { sharedPacketFilterBehaviour, mkPacket } from './meshcore.packetFilters.shared.js';

describe('MeshCoreRepository packet filters (sqlite)', () => {
  let sqlite: Database.Database;
  let repo: MeshCoreRepository;

  beforeEach(() => {
    const t = createTestDb();
    sqlite = t.sqlite;
    repo = new MeshCoreRepository(t.db, 'sqlite');
  });
  afterEach(() => sqlite.close());

  sharedPacketFilterBehaviour(() => repo);

  it('never leaks across sources', async () => {
    await repo.insertPacket(mkPacket({ sourceId: 'A', srcHash: 'ab', senderPubKey: 'ab'.repeat(32), advertName: 'Alpha' }));
    await repo.insertPacket(mkPacket({ sourceId: 'B', srcHash: 'ab', senderPubKey: 'ab'.repeat(32), advertName: 'Alpha' }));
    for (const q of [{ search: 'alpha' }, { srcHash: 'ab' }, { senderPubKey: 'ab' }]) {
      expect(await repo.getPackets({ sourceId: 'A', ...q })).toHaveLength(1);
    }
    const d = await repo.getPacketDistribution({ sourceId: 'A' });
    expect(d.total).toBe(1);
    expect(d.topSenders[0].count).toBe(1);
  });

  it('treats % and _ in search literally', async () => {
    await repo.insertPacket(mkPacket({ advertName: '50% off' }));
    await repo.insertPacket(mkPacket({ advertName: '50 percent', timestamp: 2 }));
    expect(await repo.getPackets({ sourceId: 'S', search: '50%' })).toHaveLength(1);
  });
});
