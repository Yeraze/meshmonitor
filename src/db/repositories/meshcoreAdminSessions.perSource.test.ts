/**
 * MeshCoreAdminSessionsRepository (#5785) on SQLite, PostgreSQL and MySQL, with
 * the table built by migration 204 itself (run twice: it must be idempotent).
 * Most cases are about source isolation: a session on one source must never
 * show up, or be cleared, through another.
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
import { MeshCoreAdminSessionsRepository, type MeshCoreAdminSessionRow } from './meshcoreAdminSessions.js';
import {
  migration as migration204,
  runMigration204Postgres,
  runMigration204Mysql,
} from '../../server/migrations/204_create_meshcore_admin_sessions.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from './test-utils.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const SRC_A = 'src-a';
const SRC_B = 'src-b';
const TARGET = 'a'.repeat(64);
const TARGET2 = 'c'.repeat(64);
const SELF = 'b'.repeat(64);
// Above 2^31 ms: the column must be BIGINT on PG/MySQL.
const AT = 1_760_000_000_000;

const row = (over: Partial<MeshCoreAdminSessionRow> = {}): MeshCoreAdminSessionRow => ({
  sourceId: SRC_A,
  targetPublicKey: TARGET,
  selfPublicKey: SELF,
  loggedInAt: AT,
  isAdmin: true,
  ...over,
});

function runRepoSuite(getRepo: () => MeshCoreAdminSessionsRepository, clear: () => Promise<void>) {
  let repo: MeshCoreAdminSessionsRepository;
  beforeEach(async () => {
    await clear();
    repo = getRepo();
  });

  it('requires a sourceId', async () => {
    await expect(repo.get('', TARGET)).rejects.toThrow(/sourceId/);
    await expect(repo.record(row({ sourceId: '' }))).rejects.toThrow(/sourceId/);
    await expect(repo.clear('', TARGET)).rejects.toThrow(/sourceId/);
    await expect(repo.deleteBySourceId('')).rejects.toThrow(/sourceId/);
  });

  it('round-trips a row, including a null admin flag and a BIGINT timestamp', async () => {
    await repo.record(row());
    expect(await repo.get(SRC_A, TARGET)).toEqual(row());
    await repo.record(row({ targetPublicKey: TARGET2, isAdmin: null }));
    expect((await repo.get(SRC_A, TARGET2))?.isAdmin).toBeNull();
  });

  it('upserts on (sourceId, targetPublicKey) and lower-cases keys', async () => {
    await repo.record(row({ targetPublicKey: TARGET.toUpperCase() }));
    await repo.record(row({ selfPublicKey: 'd'.repeat(64), loggedInAt: AT + 5, isAdmin: false }));
    expect(await repo.get(SRC_A, TARGET.toUpperCase())).toEqual(
      row({ selfPublicKey: 'd'.repeat(64), loggedInAt: AT + 5, isAdmin: false }),
    );
  });

  it('keeps sources apart: read, clear and purge never cross a source', async () => {
    await repo.record(row());
    await repo.record(row({ sourceId: SRC_B, loggedInAt: AT + 1 }));
    expect((await repo.get(SRC_A, TARGET))?.loggedInAt).toBe(AT);
    expect((await repo.get(SRC_B, TARGET))?.loggedInAt).toBe(AT + 1);

    await repo.clear(SRC_A, TARGET);
    expect(await repo.get(SRC_A, TARGET)).toBeNull();
    expect(await repo.get(SRC_B, TARGET)).not.toBeNull();

    await repo.record(row());
    await repo.deleteBySourceId(SRC_B);
    expect(await repo.get(SRC_B, TARGET)).toBeNull();
    expect(await repo.get(SRC_A, TARGET)).not.toBeNull();
  });
}

describe('MeshCoreAdminSessionsRepository — SQLite (migration registry)', () => {
  let t: ReturnType<typeof createTestDb>;
  beforeAll(() => { t = createTestDb(); });
  afterAll(() => { t.sqlite.close(); });

  it('migration 204 is idempotent on SQLite', () => {
    expect(() => migration204.up(t.sqlite)).not.toThrow();
    expect(() => migration204.up(t.sqlite)).not.toThrow();
  });

  runRepoSuite(
    () => new MeshCoreAdminSessionsRepository(t.db, 'sqlite'),
    async () => { t.sqlite.prepare('DELETE FROM meshcore_admin_sessions').run(); },
  );
});

describe('MeshCoreAdminSessionsRepository — bare SQLite table from migration 204', () => {
  const sqlite = new Database(':memory:');
  migration204.up(sqlite);
  migration204.up(sqlite);
  const db = drizzleSqlite(sqlite, { schema });
  afterAll(() => sqlite.close());
  runRepoSuite(
    () => new MeshCoreAdminSessionsRepository(db, 'sqlite'),
    async () => { sqlite.prepare('DELETE FROM meshcore_admin_sessions').run(); },
  );
});

describe.skipIf(!postgresAvailable)('MeshCoreAdminSessionsRepository — PostgreSQL (container)', () => {
  let pool: import('pg').Pool;
  let cleanup: (() => Promise<void>) | undefined;
  let db: ReturnType<typeof drizzlePostgres>;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig204'));
    const client = await pool.connect();
    try {
      await runMigration204Postgres(client);
      await runMigration204Postgres(client); // idempotent
    } finally {
      client.release();
    }
    db = drizzlePostgres(pool, { schema });
  });
  afterAll(async () => { await cleanup?.(); });

  runRepoSuite(
    () => new MeshCoreAdminSessionsRepository(db as never, 'postgres'),
    async () => { await pool.query('DELETE FROM meshcore_admin_sessions'); },
  );
});

describe.skipIf(!mysqlAvailable)('MeshCoreAdminSessionsRepository — MySQL (container)', () => {
  let pool: import('mysql2/promise').Pool;
  let cleanup: (() => Promise<void>) | undefined;
  let db: ReturnType<typeof drizzleMysql>;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig204'));
    await runMigration204Mysql(pool);
    await runMigration204Mysql(pool); // idempotent
    db = drizzleMysql(pool, { schema, mode: 'default' });
  });
  afterAll(async () => { await cleanup?.(); });

  runRepoSuite(
    () => new MeshCoreAdminSessionsRepository(db as never, 'mysql'),
    async () => { await pool.query('DELETE FROM meshcore_admin_sessions'); },
  );
});
