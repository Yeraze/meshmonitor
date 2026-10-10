/**
 * MeshCoreHopSnrRepository (#5722) on SQLite, PostgreSQL and MySQL, with the
 * table built by migration 201 itself (run twice: it must be idempotent).
 *
 * PostgreSQL / MySQL run against the test containers on 5433 / 3307, each in a
 * private database. They skip silently without the containers — confirm via
 * the JSON reporter's numPendingTests.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import * as schema from '../schema/index.js';
import { MeshCoreHopSnrRepository, type MeshCoreHopSnrRow } from './meshcoreHopSnr.js';
import {
  migration as migration201,
  runMigration201Postgres,
  runMigration201Mysql,
} from '../../server/migrations/201_create_meshcore_hop_snr.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from './test-utils.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const SRC_A = 'src-a';
const SRC_B = 'src-b';
const K1 = 'a'.repeat(64);
const K2 = 'b'.repeat(64);
// Above 2^31: PG/MySQL INTEGER would overflow, the columns must be BIGINT.
const TAG = 0xfedcba98;

const row = (over: Partial<MeshCoreHopSnrRow> = {}): MeshCoreHopSnrRow => ({
  sourceId: SRC_A,
  traceTag: TAG,
  authCode: 0xffffffff,
  hopIndex: 0,
  hopCount: 2,
  hashBytes: 1,
  senderPublicKey: K1,
  senderHash: 'aa',
  senderCandidates: 1,
  receiverPublicKey: K2,
  receiverHash: 'bb',
  receiverCandidates: 1,
  snrQuarterDb: -37,
  initiated: false,
  timestamp: 5000,
  ...over,
});

function runRepoSuite(getRepo: () => MeshCoreHopSnrRepository, clear: () => Promise<void>) {
  let repo: MeshCoreHopSnrRepository;
  beforeEach(async () => {
    await clear();
    repo = getRepo();
  });

  it('requires a sourceId', async () => {
    await expect(repo.getRecent('', 0)).rejects.toThrow(/sourceId/);
    await expect(repo.insertHops('', [row()])).rejects.toThrow(/sourceId/);
  });

  it('round-trips a row exactly: unsigned 32-bit ids, negative SNR, nulls, booleans', async () => {
    await repo.insertHops(SRC_A, [
      row(),
      row({ hopIndex: 1, senderPublicKey: null, senderHash: null, senderCandidates: 0, receiverPublicKey: null, receiverHash: 'c3', receiverCandidates: 2, initiated: true, snrQuarterDb: 48 }),
    ]);
    const rows = await repo.getRecent(SRC_A, 0);
    expect(rows).toHaveLength(2);
    const first = rows.find((r) => r.hopIndex === 0)!;
    expect(first).toMatchObject({
      sourceId: SRC_A, traceTag: TAG, authCode: 0xffffffff, hopCount: 2, hashBytes: 1,
      senderPublicKey: K1, senderHash: 'aa', senderCandidates: 1,
      receiverPublicKey: K2, receiverHash: 'bb', receiverCandidates: 1,
      snrQuarterDb: -37, initiated: false, timestamp: 5000,
    });
    const second = rows.find((r) => r.hopIndex === 1)!;
    expect(second).toMatchObject({
      senderPublicKey: null, senderHash: null, senderCandidates: 0,
      receiverPublicKey: null, receiverHash: 'c3', receiverCandidates: 2,
      snrQuarterDb: 48, initiated: true,
    });
  });

  it('hasTrace matches tag + auth inside the window, per source', async () => {
    await repo.insertHops(SRC_A, [row()]);
    expect(await repo.hasTrace(SRC_A, TAG, 0xffffffff, 4000)).toBe(true);
    expect(await repo.hasTrace(SRC_A, TAG, 0xffffffff, 6000)).toBe(false);
    expect(await repo.hasTrace(SRC_A, TAG, 1, 0)).toBe(false);
    expect(await repo.hasTrace(SRC_B, TAG, 0xffffffff, 0)).toBe(false);
  });

  it('node history returns rows where the node is either end, newest first, per source', async () => {
    await repo.insertHops(SRC_A, [
      row({ timestamp: 1000 }),
      row({ timestamp: 3000, senderPublicKey: K2, receiverPublicKey: K1 }),
      row({ timestamp: 2000, senderPublicKey: 'c'.repeat(64), receiverPublicKey: 'd'.repeat(64) }),
    ]);
    await repo.insertHops(SRC_B, [row({ sourceId: SRC_B, timestamp: 9000 })]);
    const rows = await repo.getHistoryForNode(SRC_A, K1, 0);
    expect(rows.map((r) => r.timestamp)).toEqual([3000, 1000]);
    expect(await repo.getHistoryForNode(SRC_A, K1, 2500)).toHaveLength(1);
    expect((await repo.getRecent(SRC_A, 0)).every((r) => r.sourceId === SRC_A)).toBe(true);
  });

  it('retention and source deletion touch only that source', async () => {
    await repo.insertHops(SRC_A, [row({ timestamp: 1000 }), row({ timestamp: 9000 })]);
    await repo.insertHops(SRC_B, [row({ sourceId: SRC_B, timestamp: 1000 })]);
    await repo.deleteOlderThan(SRC_A, 5000);
    expect((await repo.getRecent(SRC_A, 0)).map((r) => r.timestamp)).toEqual([9000]);
    expect(await repo.getRecent(SRC_B, 0)).toHaveLength(1);
    await repo.deleteBySourceId(SRC_A);
    expect(await repo.getRecent(SRC_A, 0)).toEqual([]);
    expect(await repo.getRecent(SRC_B, 0)).toHaveLength(1);
  });
}

describe('MeshCoreHopSnrRepository — SQLite (migration registry)', () => {
  let t: ReturnType<typeof createTestDb>;
  beforeAll(() => { t = createTestDb(); });
  afterAll(() => { t.sqlite.close(); });

  it('migration 201 is idempotent on SQLite', () => {
    expect(() => migration201.up(t.sqlite)).not.toThrow();
    expect(() => migration201.up(t.sqlite)).not.toThrow();
  });

  runRepoSuite(
    () => new MeshCoreHopSnrRepository(t.db, 'sqlite'),
    async () => { t.sqlite.prepare('DELETE FROM meshcore_hop_snr').run(); },
  );
});

describe('MeshCoreHopSnrRepository — bare SQLite table from migration 201', () => {
  const sqlite = new Database(':memory:');
  migration201.up(sqlite);
  migration201.up(sqlite);
  const db = drizzleSqlite(sqlite, { schema });
  afterAll(() => sqlite.close());
  runRepoSuite(
    () => new MeshCoreHopSnrRepository(db, 'sqlite'),
    async () => { sqlite.prepare('DELETE FROM meshcore_hop_snr').run(); },
  );
});

describe.skipIf(!postgresAvailable)('MeshCoreHopSnrRepository — PostgreSQL (container)', () => {
  let pool: import('pg').Pool;
  let cleanup: (() => Promise<void>) | undefined;
  let db: ReturnType<typeof drizzlePostgres>;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig201'));
    const client = await pool.connect();
    try {
      await runMigration201Postgres(client);
      await runMigration201Postgres(client); // idempotent
    } finally {
      client.release();
    }
    db = drizzlePostgres(pool, { schema });
  });
  afterAll(async () => { await cleanup?.(); });

  runRepoSuite(
    () => new MeshCoreHopSnrRepository(db as never, 'postgres'),
    async () => { await pool.query('DELETE FROM meshcore_hop_snr'); },
  );
});

describe.skipIf(!mysqlAvailable)('MeshCoreHopSnrRepository — MySQL (container)', () => {
  let pool: import('mysql2/promise').Pool;
  let cleanup: (() => Promise<void>) | undefined;
  let db: ReturnType<typeof drizzleMysql>;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig201'));
    await runMigration201Mysql(pool);
    await runMigration201Mysql(pool); // idempotent
    db = drizzleMysql(pool, { schema, mode: 'default' });
  });
  afterAll(async () => { await cleanup?.(); });

  runRepoSuite(
    () => new MeshCoreHopSnrRepository(db as never, 'mysql'),
    async () => { await pool.query('DELETE FROM meshcore_hop_snr'); },
  );
});
