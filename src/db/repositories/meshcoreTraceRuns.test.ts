/**
 * MeshCoreTraceRunsRepository (#6276) on SQLite, PostgreSQL and MySQL, with
 * the table built by migration 225 itself (run twice: it must be idempotent).
 *
 * PostgreSQL / MySQL run against the test containers on 5433 / 3307, each in a
 * private database. They skip silently without the containers: confirm via the
 * JSON reporter's numPendingTests.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import * as schema from '../schema/index.js';
import { MeshCoreTraceRunsRepository, type MeshCoreTraceRunRow } from './meshcoreTraceRuns.js';
import { migration as migration225, runMigration225Postgres, runMigration225Mysql } from '../../server/migrations/225_add_meshcore_trace_runs.js';
import { postgresAvailable, mysqlAvailable, createIsolatedPostgresDatabase, createIsolatedMysqlDatabase } from './test-utils.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const A = 'src-a';
const B = 'src-b';
const KEY = 'ab'.repeat(32);
// Above 2^31: the columns must be BIGINT on PostgreSQL / MySQL.
const TAG = 0xfedcba98;

const pending = (o: Partial<Omit<MeshCoreTraceRunRow, 'id' | 'status' | 'completedAt'>> = {}) => ({
  sourceId: A, traceTag: TAG, authCode: 0, targetPublicKey: KEY.toUpperCase(), pathHex: '1122', hashBytes: 1,
  autoReturn: true, origin: 'manual' as const, sentAt: 5000, ...o,
});

function runSuite(getRepo: () => MeshCoreTraceRunsRepository, clear: () => Promise<void>) {
  let repo: MeshCoreTraceRunsRepository;
  beforeEach(async () => {
    await clear();
    repo = getRepo();
  });

  it('requires a sourceId', async () => {
    await expect(repo.insertPending(pending({ sourceId: '' }))).rejects.toThrow(/sourceId/);
    await expect(repo.getForExplorer('', 0, 5)).rejects.toThrow(/sourceId/);
    await expect(repo.deleteBySourceId('')).rejects.toThrow(/sourceId/);
  });

  it('round-trips a run and settles it once; pending runs are not listed', async () => {
    await repo.insertPending(pending());
    expect((await repo.getForExplorer(A, 0, 10)).runs).toEqual([]);
    expect(await repo.complete(A, TAG, 0, 'answered', 6000)).toBe(1);
    // Already settled: a second outcome changes nothing.
    expect(await repo.complete(A, TAG, 0, 'timeout', 7000)).toBe(0);
    const { runs, truncated } = await repo.getForExplorer(A, 0, 10);
    expect(truncated).toBe(false);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      sourceId: A, traceTag: TAG, authCode: 0, targetPublicKey: KEY, pathHex: '1122', hashBytes: 1,
      autoReturn: true, origin: 'manual', status: 'answered', sentAt: 5000, completedAt: 6000,
    });
  });

  it('complete matches by source, tag and auth', async () => {
    await repo.insertPending(pending());
    expect(await repo.complete(B, TAG, 0, 'failed', 1)).toBe(0);
    expect(await repo.complete(A, TAG + 1, 0, 'failed', 1)).toBe(0);
    expect(await repo.complete(A, TAG, 1, 'failed', 1)).toBe(0);
    expect(await repo.complete(A, TAG, 0, 'failed', 1)).toBe(1);
  });

  it('lists newest first, within the window, per source, and flags the cap', async () => {
    for (const [i, ts] of [1000, 3000, 2000].entries()) {
      await repo.insertPending(pending({ traceTag: i + 1, sentAt: ts }));
      await repo.complete(A, i + 1, 0, i === 1 ? 'timeout' : 'answered', ts + 1);
    }
    await repo.insertPending(pending({ sourceId: B, traceTag: 9, sentAt: 9000 }));
    await repo.complete(B, 9, 0, 'failed', 9001);
    const all = await repo.getForExplorer(A, 0, 10);
    expect(all.runs.map((r) => r.sentAt)).toEqual([3000, 2000, 1000]);
    expect((await repo.getForExplorer(A, 1500, 10)).runs.map((r) => r.sentAt)).toEqual([3000, 2000]);
    const capped = await repo.getForExplorer(A, 0, 2);
    expect(capped.truncated).toBe(true);
    expect(capped.runs).toHaveLength(2);
    expect((await repo.getForExplorer(A, 0, 3)).truncated).toBe(false);
    expect((await repo.getForExplorer(B, 0, 10)).runs).toHaveLength(1);
    expect(await repo.getForExplorer(A, 0, 0)).toEqual({ runs: [], truncated: false });
  });

  it('sweeps stale pending runs to timeout, only before the cutoff and only on that source', async () => {
    await repo.insertPending(pending({ traceTag: 1, sentAt: 1000 }));
    await repo.insertPending(pending({ traceTag: 2, sentAt: 9000 }));
    await repo.insertPending(pending({ sourceId: B, traceTag: 3, sentAt: 1000 }));
    expect(await repo.sweepStalePending(A, 5000, 5555)).toBe(1);
    expect(await repo.sweepStalePending(A, 5000, 5555)).toBe(0);
    const swept = (await repo.getForExplorer(A, 0, 10)).runs;
    expect(swept).toHaveLength(1);
    expect(swept[0]).toMatchObject({ traceTag: 1, status: 'timeout', completedAt: 5555 });
    expect((await repo.getForExplorer(B, 0, 10)).runs).toEqual([]);
  });

  it('retention and source deletion touch only that source', async () => {
    for (const [tag, ts] of [[1, 1000], [2, 9000]]) {
      await repo.insertPending(pending({ traceTag: tag, sentAt: ts }));
      await repo.complete(A, tag, 0, 'answered', ts);
    }
    await repo.insertPending(pending({ sourceId: B, traceTag: 3, sentAt: 1000 }));
    await repo.complete(B, 3, 0, 'answered', 1000);
    await repo.deleteOlderThan(A, 5000);
    expect((await repo.getForExplorer(A, 0, 10)).runs.map((r) => r.traceTag)).toEqual([2]);
    expect((await repo.getForExplorer(B, 0, 10)).runs).toHaveLength(1);
    await repo.deleteBySourceId(A);
    expect((await repo.getForExplorer(A, 0, 10)).runs).toEqual([]);
    expect((await repo.getForExplorer(B, 0, 10)).runs).toHaveLength(1);
  });
}

describe('MeshCoreTraceRunsRepository — SQLite (migration registry)', () => {
  let t: ReturnType<typeof createTestDb>;
  beforeAll(() => { t = createTestDb(); });
  afterAll(() => { t.sqlite.close(); });

  it('migration 225 is idempotent on SQLite', () => {
    expect(() => migration225.up(t.sqlite)).not.toThrow();
    expect(() => migration225.up(t.sqlite)).not.toThrow();
  });

  runSuite(
    () => new MeshCoreTraceRunsRepository(t.db, 'sqlite'),
    async () => { t.sqlite.prepare('DELETE FROM meshcore_trace_runs').run(); },
  );
});

describe('MeshCoreTraceRunsRepository — bare SQLite table from migration 225', () => {
  const sqlite = new Database(':memory:');
  migration225.up(sqlite);
  migration225.up(sqlite);
  const db = drizzleSqlite(sqlite, { schema });
  afterAll(() => sqlite.close());
  runSuite(
    () => new MeshCoreTraceRunsRepository(db, 'sqlite'),
    async () => { sqlite.prepare('DELETE FROM meshcore_trace_runs').run(); },
  );
});

describe.skipIf(!postgresAvailable)('MeshCoreTraceRunsRepository — PostgreSQL (container)', () => {
  let pool: import('pg').Pool;
  let cleanup: (() => Promise<void>) | undefined;
  let db: ReturnType<typeof drizzlePostgres>;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig225'));
    const client = await pool.connect();
    try {
      await runMigration225Postgres(client);
      await runMigration225Postgres(client); // idempotent
    } finally {
      client.release();
    }
    db = drizzlePostgres(pool, { schema });
  });
  afterAll(async () => { await cleanup?.(); });

  runSuite(
    () => new MeshCoreTraceRunsRepository(db as never, 'postgres'),
    async () => { await pool.query('DELETE FROM meshcore_trace_runs'); },
  );
});

describe.skipIf(!mysqlAvailable)('MeshCoreTraceRunsRepository — MySQL (container)', () => {
  let pool: import('mysql2/promise').Pool;
  let cleanup: (() => Promise<void>) | undefined;
  let db: ReturnType<typeof drizzleMysql>;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig225'));
    await runMigration225Mysql(pool);
    await runMigration225Mysql(pool); // idempotent
    db = drizzleMysql(pool, { schema, mode: 'default' });
  });
  afterAll(async () => { await cleanup?.(); });

  runSuite(
    () => new MeshCoreTraceRunsRepository(db as never, 'mysql'),
    async () => { await pool.query('DELETE FROM meshcore_trace_runs'); },
  );
});
