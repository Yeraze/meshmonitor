/**
 * PkiExchangeStateRepository (#5691, Reliable PKI) on SQLite, PostgreSQL and
 * MySQL, with the tables built by migration 198 itself (run twice: the
 * migration must be idempotent).
 *
 * PostgreSQL / MySQL run against the test containers on 5433 / 3307, each in a
 * private database (createIsolated*Database) so no other suite can drop the
 * table mid-run. They skip silently without the containers — confirm via the
 * JSON reporter's numPendingTests, not the pass/fail summary.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import * as schema from '../schema/index.js';
import { PkiExchangeStateRepository } from './pkiExchangeState.js';
import {
  migration as migration198,
  runMigration198Postgres,
  runMigration198Mysql,
} from '../../server/migrations/198_create_pki_exchange_state.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from './test-utils.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const SRC_A = 'src-a';
const SRC_B = 'src-b';
// Above 2^31: PG/MySQL INTEGER would overflow, the column must be BIGINT.
const NODE = 0xfedcba98;

function runRepoSuite(getRepo: () => PkiExchangeStateRepository, clear: () => Promise<void>) {
  let repo: PkiExchangeStateRepository;
  beforeEach(async () => {
    await clear();
    repo = getRepo();
  });

  it('returns null for an unknown node', async () => {
    expect(await repo.getState(SRC_A, NODE)).toBeNull();
  });

  it('requires a sourceId', async () => {
    await expect(repo.getState('', NODE)).rejects.toThrow(/sourceId/);
    await expect(repo.markPending('', NODE)).rejects.toThrow(/sourceId/);
  });

  it('pending → failed → successful, keeping failingSince until success', async () => {
    await repo.markPending(SRC_A, NODE, 1000);
    let row = await repo.getState(SRC_A, NODE);
    expect(row).toMatchObject({ state: 'pending', stateChangedAt: 1000, nodeNum: NODE });

    await repo.markFailed(SRC_A, NODE, 'timeout', 2000);
    await repo.markPending(SRC_A, NODE, 2500);
    await repo.markFailed(SRC_A, NODE, 'pki_unknown_pubkey', 3000);
    row = await repo.getState(SRC_A, NODE);
    expect(row).toMatchObject({ state: 'failed', failingSince: 2000, lastFailureReason: 'pki_unknown_pubkey' });

    await repo.markSuccessful(SRC_A, NODE, 4000);
    row = await repo.getState(SRC_A, NODE);
    expect(row).toMatchObject({ state: 'successful', lastSuccessAt: 4000, failingSince: null, lastFailureReason: null });
  });

  it('recordPriming stamps the timer and survives later state changes', async () => {
    await repo.markFailed(SRC_A, NODE, 'timeout', 1000);
    await repo.recordPriming(SRC_A, NODE, 1500);
    await repo.markPending(SRC_A, NODE, 1600);
    await repo.markSuccessful(SRC_A, NODE, 1700);
    expect((await repo.getState(SRC_A, NODE))?.lastPrimedAt).toBe(1500);
  });

  it('recordPriming on a node with no row creates it as failed', async () => {
    await repo.recordPriming(SRC_A, NODE, 1500);
    expect(await repo.getState(SRC_A, NODE)).toMatchObject({ state: 'failed', lastPrimedAt: 1500 });
  });

  it('keeps sources apart and deleteBySourceId only removes its own rows', async () => {
    await repo.markFailed(SRC_A, NODE, 'timeout', 1000);
    await repo.markSuccessful(SRC_B, NODE, 1000);
    expect((await repo.getState(SRC_A, NODE))?.state).toBe('failed');
    expect((await repo.getState(SRC_B, NODE))?.state).toBe('successful');
    await repo.deleteBySourceId(SRC_A);
    expect(await repo.getState(SRC_A, NODE)).toBeNull();
    expect((await repo.getState(SRC_B, NODE))?.state).toBe('successful');
  });
}

describe('PkiExchangeStateRepository — SQLite (migration registry)', () => {
  let t: ReturnType<typeof createTestDb>;
  beforeAll(() => { t = createTestDb(); });
  afterAll(() => { t.sqlite.close(); });

  it('migration 198 is idempotent on SQLite', () => {
    expect(() => migration198.up(t.sqlite)).not.toThrow();
    expect(() => migration198.up(t.sqlite)).not.toThrow();
  });

  it('enforces one row per (sourceId, nodeNum)', () => {
    const insert = () => t.sqlite.prepare(
      'INSERT INTO pki_exchange_state (sourceId, nodeNum, state, stateChangedAt, updatedAt) VALUES (?, ?, ?, ?, ?)',
    ).run('dup', 1, 'pending', 1, 1);
    insert();
    expect(insert).toThrow();
    t.sqlite.prepare("DELETE FROM pki_exchange_state WHERE sourceId = 'dup'").run();
  });

  runRepoSuite(
    () => new PkiExchangeStateRepository(t.db, 'sqlite'),
    async () => { t.sqlite.prepare('DELETE FROM pki_exchange_state').run(); },
  );
});

describe('PkiExchangeStateRepository — bare SQLite table from migration 198', () => {
  const sqlite = new Database(':memory:');
  migration198.up(sqlite);
  migration198.up(sqlite);
  const db = drizzleSqlite(sqlite, { schema });
  afterAll(() => sqlite.close());
  runRepoSuite(
    () => new PkiExchangeStateRepository(db, 'sqlite'),
    async () => { sqlite.prepare('DELETE FROM pki_exchange_state').run(); },
  );
});

describe.skipIf(!postgresAvailable)('PkiExchangeStateRepository — PostgreSQL (container)', () => {
  let pool: import('pg').Pool;
  let cleanup: (() => Promise<void>) | undefined;
  let db: ReturnType<typeof drizzlePostgres>;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig198'));
    const client = await pool.connect();
    try {
      await runMigration198Postgres(client);
      await runMigration198Postgres(client); // idempotent
    } finally {
      client.release();
    }
    db = drizzlePostgres(pool, { schema });
  });
  afterAll(async () => { await cleanup?.(); });

  it('the table has a unique (sourceId, nodeNum) index', async () => {
    const q = `INSERT INTO pki_exchange_state ("sourceId", "nodeNum", state, "stateChangedAt", "updatedAt") VALUES ('dup', 1, 'pending', 1, 1)`;
    await pool.query(q);
    await expect(pool.query(q)).rejects.toThrow();
    await pool.query(`DELETE FROM pki_exchange_state WHERE "sourceId" = 'dup'`);
  });

  runRepoSuite(
    () => new PkiExchangeStateRepository(db as never, 'postgres'),
    async () => { await pool.query('DELETE FROM pki_exchange_state'); },
  );
});

describe.skipIf(!mysqlAvailable)('PkiExchangeStateRepository — MySQL (container)', () => {
  let pool: import('mysql2/promise').Pool;
  let cleanup: (() => Promise<void>) | undefined;
  let db: ReturnType<typeof drizzleMysql>;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig198'));
    await runMigration198Mysql(pool);
    await runMigration198Mysql(pool); // idempotent
    db = drizzleMysql(pool, { schema, mode: 'default' });
  });
  afterAll(async () => { await cleanup?.(); });

  it('the table has a unique (sourceId, nodeNum) index', async () => {
    const q = `INSERT INTO pki_exchange_state (sourceId, nodeNum, state, stateChangedAt, updatedAt) VALUES ('dup', 1, 'pending', 1, 1)`;
    await pool.query(q);
    await expect(pool.query(q)).rejects.toThrow();
    await pool.query(`DELETE FROM pki_exchange_state WHERE sourceId = 'dup'`);
  });

  runRepoSuite(
    () => new PkiExchangeStateRepository(db as never, 'mysql'),
    async () => { await pool.query('DELETE FROM pki_exchange_state'); },
  );
});
