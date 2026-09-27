/**
 * MeshCore Repository — getNeighborsForReporter per-source isolation (#5413).
 *
 * A partial neighbour fetch is merged with the stored set for ONE reporter on
 * ONE source, so the read must not pull rows from another source or another
 * reporter.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { MeshCoreRepository } from './meshcore.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const REPORTER = 'a'.repeat(64);
const OTHER_REPORTER = 'b'.repeat(64);
const N1 = '1'.repeat(64);
const N2 = '2'.repeat(64);

describe('MeshCoreRepository.getNeighborsForReporter', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: MeshCoreRepository;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    repo = new MeshCoreRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  it('requires a sourceId', async () => {
    await expect(repo.getNeighborsForReporter('', REPORTER)).rejects.toThrow(/sourceId/);
  });

  it('returns only the rows for that reporter on that source', async () => {
    await repo.insertNeighborsBatch('src-a', REPORTER, [
      { neighborPublicKey: N1, snr: 4.5, lastHeardSecs: 30 },
      { neighborPublicKey: N2, snr: -1, lastHeardSecs: null },
    ]);
    await repo.insertNeighborsBatch('src-b', REPORTER, [{ neighborPublicKey: N1, snr: 9, lastHeardSecs: 5 }]);
    await repo.insertNeighborsBatch('src-a', OTHER_REPORTER, [{ neighborPublicKey: N2, snr: 9, lastHeardSecs: 5 }]);

    const rows = await repo.getNeighborsForReporter('src-a', REPORTER);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.neighborPublicKey).sort()).toEqual([N1, N2]);
    const n1 = rows.find((r) => r.neighborPublicKey === N1)!;
    expect(n1).toMatchObject({ snr: 4.5, lastHeardSecs: 30 });
    expect(typeof n1.timestamp).toBe('number');
    expect(n1.timestamp).toBeGreaterThan(0);

    expect(await repo.getNeighborsForReporter('src-c', REPORTER)).toEqual([]);
  });
});
