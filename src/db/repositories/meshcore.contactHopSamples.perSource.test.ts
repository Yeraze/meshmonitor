/** getContactHopSamples / getContactSignalSamples per-source isolation (#6262). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { MeshCoreRepository, type DbMeshCoreMessage } from './meshcore.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const KEY = 'aa'.repeat(32);
const OTHER_KEY = 'cc'.repeat(32);
let seq = 0;
const msg = (sourceId: string, over: Partial<DbMeshCoreMessage> = {}): DbMeshCoreMessage => ({
  id: `m-${++seq}`,
  fromPublicKey: KEY,
  toPublicKey: 'bb'.repeat(32),
  text: 'hi',
  timestamp: 1000,
  messageType: 'text',
  sourceId,
  createdAt: 1000,
  ...over,
});

describe('MeshCoreRepository contact samples', () => {
  let db: Database.Database;
  let repo: MeshCoreRepository;
  beforeEach(async () => {
    seq = 0;
    const t = createTestDb();
    db = t.sqlite;
    repo = new MeshCoreRepository(t.db, 'sqlite');
    await repo.insertMessage(msg('a', { timestamp: 3000, hopCount: 2, snr: 5.5, rssi: -90 }), 'a');
    await repo.insertMessage(msg('a', { timestamp: 2000, hopCount: 1, snr: 7, rssi: null }), 'a');
    await repo.insertMessage(msg('a', { timestamp: 2500, hopCount: null, snr: null, rssi: null }), 'a');
    await repo.insertMessage(msg('a', { timestamp: 500, hopCount: 4, snr: 1, rssi: -100 }), 'a');
    await repo.insertMessage(msg('a', { fromPublicKey: OTHER_KEY, timestamp: 2200, hopCount: 3, snr: 2, rssi: -80 }), 'a');
    await repo.insertMessage(msg('b', { timestamp: 2100, hopCount: 6, snr: -3, rssi: -120 }), 'b');
  });
  afterEach(() => db.close());

  it('throws without sourceId', async () => {
    await expect(repo.getContactHopSamples('', KEY, 0)).rejects.toThrow(/sourceId/);
    await expect(repo.getContactSignalSamples('', KEY, 0)).rejects.toThrow(/sourceId/);
  });

  it('hop samples: ascending, hopCount present, one source, one contact, since-bounded', async () => {
    expect(await repo.getContactHopSamples('a', KEY, 1000)).toEqual([
      { timestamp: 2000, value: 1 },
      { timestamp: 3000, value: 2 },
    ]);
    expect(await repo.getContactHopSamples('b', KEY, 0)).toEqual([{ timestamp: 2100, value: 6 }]);
    expect(await repo.getContactHopSamples('zzz', KEY, 0)).toEqual([]);
  });

  it('signal samples: only rows with snr or rssi, newest first, source scoped', async () => {
    expect(await repo.getContactSignalSamples('a', KEY, 1000)).toEqual([
      { timestamp: 3000, snr: 5.5, rssi: -90 },
      { timestamp: 2000, snr: 7, rssi: null },
    ]);
    expect(await repo.getContactSignalSamples('b', KEY, 0)).toEqual([{ timestamp: 2100, snr: -3, rssi: -120 }]);
  });
});
