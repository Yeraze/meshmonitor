/**
 * MeshCore CLI history (#5892): MeshCoreCliHistoryRepository on SQLite /
 * PostgreSQL / MySQL (table built by migration 212, run twice).
 *
 * PostgreSQL / MySQL run against the test containers on 5433 / 3307, each in a
 * private database. They skip silently without the containers — confirm via
 * the JSON reporter's numPendingTests.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import * as schema from '../schema/index.js';
import {
  MeshCoreCliHistoryRepository,
  CLI_HISTORY_TEXT_CAP,
  type NewMeshCoreCliHistoryRow,
} from './meshcoreCliHistory.js';
import {
  migration as migration212,
  runMigration212Postgres,
  runMigration212Mysql,
} from '../../server/migrations/212_create_meshcore_cli_history.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from './test-utils.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const SRC_A = 'src-a';
const SRC_B = 'src-b';
const KEY = 'ab'.repeat(32);
const DAY = 24 * 60 * 60 * 1000;

const row = (over: Partial<NewMeshCoreCliHistoryRow> = {}): NewMeshCoreCliHistoryRow => ({
  sourceId: SRC_A,
  timestamp: 1_700_000_000_000,
  targetKind: 'remote',
  targetPublicKey: KEY,
  targetName: 'Hill Repeater',
  origin: 'user',
  userId: 7,
  username: 'alice',
  command: 'ver',
  outcome: 'ok',
  reply: 'v1.9.0',
  error: null,
  elapsedMs: 812,
  ipAddress: '10.0.0.5',
  ...over,
});

function runRepoSuite(getRepo: () => MeshCoreCliHistoryRepository, clear: () => Promise<void>) {
  let repo: MeshCoreCliHistoryRepository;
  beforeEach(async () => {
    await clear();
    repo = getRepo();
  });

  it('records a row and reads it back', async () => {
    await repo.record(row());
    const rows = await repo.list({ scopes: 'all' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceId: SRC_A,
      timestamp: 1_700_000_000_000,
      targetKind: 'remote',
      targetPublicKey: KEY,
      targetName: 'Hill Repeater',
      origin: 'user',
      userId: 7,
      username: 'alice',
      command: 'ver',
      outcome: 'ok',
      reply: 'v1.9.0',
      error: null,
      elapsedMs: 812,
      ipAddress: '10.0.0.5',
    });
    expect(typeof rows[0].id).toBe('number');
  });

  it('caps long replies', async () => {
    await repo.record(row({ reply: 'x'.repeat(CLI_HISTORY_TEXT_CAP + 50) }));
    const [r] = await repo.list({ scopes: 'all' });
    expect(r.reply!.length).toBe(CLI_HISTORY_TEXT_CAP + 1);
  });

  it('lists newest first and pages by the before cursor', async () => {
    for (let i = 0; i < 5; i++) await repo.record(row({ timestamp: 1000 + i, command: `c${i}` }));
    const page1 = await repo.list({ scopes: 'all', limit: 2 });
    expect(page1.map(r => r.command)).toEqual(['c4', 'c3']);
    const page2 = await repo.list({ scopes: 'all', limit: 2, before: page1[1].timestamp });
    expect(page2.map(r => r.command)).toEqual(['c2', 'c1']);
  });

  it('scopes rows by source and target kind', async () => {
    await repo.record(row({ sourceId: SRC_A, targetKind: 'remote', command: 'a-remote' }));
    await repo.record(row({ sourceId: SRC_A, targetKind: 'local', targetPublicKey: null, command: 'a-local' }));
    await repo.record(row({ sourceId: SRC_B, targetKind: 'remote', command: 'b-remote' }));

    const onlyARemote = await repo.list({ scopes: [{ sourceId: SRC_A, kinds: ['remote'] }] });
    expect(onlyARemote.map(r => r.command)).toEqual(['a-remote']);

    const aAll = await repo.list({ scopes: [{ sourceId: SRC_A, kinds: ['remote', 'local'] }] });
    expect(aAll.map(r => r.command).sort()).toEqual(['a-local', 'a-remote']);

    const mixed = await repo.list({ scopes: [{ sourceId: SRC_A, kinds: ['local'] }, { sourceId: SRC_B, kinds: ['remote'] }] });
    expect(mixed.map(r => r.command).sort()).toEqual(['a-local', 'b-remote']);

    expect(await repo.list({ scopes: [] })).toEqual([]);
    expect(await repo.list({ scopes: [{ sourceId: SRC_A, kinds: [] }] })).toEqual([]);
    expect(await repo.list({ scopes: 'all', sourceIds: [] })).toEqual([]);
    expect((await repo.list({ scopes: 'all', sourceIds: [SRC_B] })).map(r => r.command)).toEqual(['b-remote']);
  });

  it('filters by target, user and date range', async () => {
    const other = 'cd'.repeat(32);
    await repo.record(row({ timestamp: 100, username: 'alice', command: 'one' }));
    await repo.record(row({ timestamp: 200, username: 'bob', targetPublicKey: other, command: 'two' }));
    await repo.record(row({ timestamp: 300, username: 'alice', targetKind: 'local', targetPublicKey: null, command: 'three' }));

    expect((await repo.list({ scopes: 'all', targetPublicKey: other.toUpperCase() })).map(r => r.command)).toEqual(['two']);
    expect((await repo.list({ scopes: 'all', targetKind: 'local' })).map(r => r.command)).toEqual(['three']);
    expect((await repo.list({ scopes: 'all', username: 'alice' })).map(r => r.command)).toEqual(['three', 'one']);
    expect((await repo.list({ scopes: 'all', from: 150, to: 300 })).map(r => r.command)).toEqual(['three', 'two']);
  });

  it('prunes rows older than the retention', async () => {
    const now = Date.now();
    await repo.record(row({ timestamp: now - 100 * DAY, command: 'old' }));
    await repo.record(row({ timestamp: now - 91 * DAY, command: 'old2' }));
    await repo.record(row({ timestamp: now - 1 * DAY, command: 'new' }));
    expect(await repo.pruneOlderThan(90, 1)).toBe(2);
    expect((await repo.list({ scopes: 'all' })).map(r => r.command)).toEqual(['new']);
  });

  it('deletes by source', async () => {
    await repo.record(row({ sourceId: SRC_A }));
    await repo.record(row({ sourceId: SRC_B }));
    await repo.deleteBySourceId(SRC_A);
    const rows = await repo.list({ scopes: 'all' });
    expect(rows.map(r => r.sourceId)).toEqual([SRC_B]);
    await expect(repo.deleteBySourceId('')).rejects.toThrow();
  });
}

describe('MeshCoreCliHistoryRepository — SQLite (migration registry)', () => {
  let t: ReturnType<typeof createTestDb>;
  beforeAll(() => { t = createTestDb(); });
  afterAll(() => { t.sqlite.close(); });

  it('migration 212 is idempotent on SQLite', () => {
    expect(() => migration212.up(t.sqlite)).not.toThrow();
    expect(() => migration212.up(t.sqlite)).not.toThrow();
  });

  runRepoSuite(
    () => new MeshCoreCliHistoryRepository(t.db, 'sqlite'),
    async () => { t.sqlite.prepare('DELETE FROM meshcore_cli_history').run(); },
  );
});

describe.skipIf(!postgresAvailable)('MeshCoreCliHistoryRepository — PostgreSQL (container)', () => {
  let pool: import('pg').Pool;
  let cleanup: (() => Promise<void>) | undefined;
  let db: ReturnType<typeof drizzlePostgres>;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig212'));
    const client = await pool.connect();
    try {
      await runMigration212Postgres(client);
      await runMigration212Postgres(client); // idempotent
    } finally {
      client.release();
    }
    db = drizzlePostgres(pool, { schema });
  });
  afterAll(async () => { await cleanup?.(); });

  runRepoSuite(
    () => new MeshCoreCliHistoryRepository(db as never, 'postgres'),
    async () => { await pool.query('DELETE FROM meshcore_cli_history'); },
  );
});

describe.skipIf(!mysqlAvailable)('MeshCoreCliHistoryRepository — MySQL (container)', () => {
  let pool: import('mysql2/promise').Pool;
  let cleanup: (() => Promise<void>) | undefined;
  let db: ReturnType<typeof drizzleMysql>;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig212'));
    await runMigration212Mysql(pool);
    await runMigration212Mysql(pool); // idempotent
    db = drizzleMysql(pool, { schema, mode: 'default' });
  });
  afterAll(async () => { await cleanup?.(); });

  runRepoSuite(
    () => new MeshCoreCliHistoryRepository(db as never, 'mysql'),
    async () => { await pool.query('DELETE FROM meshcore_cli_history'); },
  );
});
