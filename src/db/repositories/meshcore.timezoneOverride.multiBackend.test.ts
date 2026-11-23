/**
 * #6523: MeshCoreRepository.setNodeTimezoneOverride on SQLite, PostgreSQL and
 * MySQL — source-scoped, and never cleared or set by an ingest upsert.
 * PG/MySQL halves build `meshcore_nodes` from the Drizzle schema in their own
 * isolated database.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import type pg from 'pg';
import type mysql from 'mysql2/promise';
import * as schema from '../schema/index.js';
import { buildActiveSchema } from '../activeSchema.js';
import { MeshCoreRepository } from './meshcore.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';
import { postgresCreateTable, mysqlCreateTable } from '../../server/test-helpers/drizzleDdl.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from './test-utils.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

function shared(getRepo: () => MeshCoreRepository) {
  it('sets and clears on one source only', async () => {
    const repo = getRepo();
    await repo.upsertNode({ publicKey: A, name: 'a' }, 'src-a');
    await repo.upsertNode({ publicKey: A, name: 'a' }, 'src-b');
    expect(await repo.setNodeTimezoneOverride('src-a', A, 'Europe/London')).toBe(true);
    expect((await repo.getNodeByPublicKeyAndSource(A, 'src-a'))?.timezoneOverride).toBe('Europe/London');
    expect((await repo.getNodeByPublicKeyAndSource(A, 'src-b'))?.timezoneOverride ?? null).toBeNull();
    expect(await repo.setNodeTimezoneOverride('src-a', B, 'Europe/London')).toBe(false);
    expect(await repo.getNodeByPublicKeyAndSource(B, 'src-a')).toBeNull();
    expect(await repo.setNodeTimezoneOverride('src-a', A, null)).toBe(true);
    expect((await repo.getNodeByPublicKeyAndSource(A, 'src-a'))?.timezoneOverride ?? null).toBeNull();
  });

  it('an advert/contact upsert keeps the override and ignores it in input', async () => {
    const repo = getRepo();
    await repo.upsertNode({ publicKey: A, name: 'a' }, 'src-a');
    await repo.setNodeTimezoneOverride('src-a', A, 'Asia/Tokyo');
    await repo.upsertNode({ publicKey: A, name: 'moved', latitude: 10, longitude: 20 }, 'src-a');
    // A stored row spread back in, with the key nulled or changed.
    const stored = await repo.getNodeByPublicKeyAndSource(A, 'src-a');
    await repo.upsertNode({ ...stored!, timezoneOverride: null }, 'src-a');
    await repo.upsertNode({ publicKey: A, timezoneOverride: 'Europe/Paris' }, 'src-a');
    const n = await repo.getNodeByPublicKeyAndSource(A, 'src-a');
    expect(n?.name).toBe('moved');
    expect(n?.timezoneOverride).toBe('Asia/Tokyo');
    // A fresh insert never carries one.
    await repo.upsertNode({ publicKey: B, timezoneOverride: 'Europe/Paris' }, 'src-a');
    expect((await repo.getNodeByPublicKeyAndSource(B, 'src-a'))?.timezoneOverride ?? null).toBeNull();
  });
}

describe('MeshCore timezone override — SQLite', () => {
  let db: Database.Database;
  let repo: MeshCoreRepository;
  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    repo = new MeshCoreRepository(t.db, 'sqlite');
  });
  afterEach(() => db.close());
  shared(() => repo);
});

describe.skipIf(!postgresAvailable)('MeshCore timezone override — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanupDb: (() => Promise<void>) | undefined;
  let repo: MeshCoreRepository;

  beforeAll(async () => {
    ({ pool, cleanup: cleanupDb } = await createIsolatedPostgresDatabase('mctz'));
    const tables = buildActiveSchema('postgres') as unknown as Record<string, unknown>;
    for (const statement of postgresCreateTable(tables.meshcoreNodes).split(';\n')) {
      await pool.query(statement);
    }
    repo = new MeshCoreRepository(drizzlePostgres(pool, { schema }) as never, 'postgres');
  }, 60_000);
  afterAll(async () => {
    await cleanupDb?.();
  });
  beforeEach(async () => {
    await pool.query('DELETE FROM meshcore_nodes');
  });

  shared(() => repo);
});

describe.skipIf(!mysqlAvailable)('MeshCore timezone override — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanupDb: (() => Promise<void>) | undefined;
  let repo: MeshCoreRepository;

  beforeAll(async () => {
    ({ pool, cleanup: cleanupDb } = await createIsolatedMysqlDatabase('mctz'));
    const tables = buildActiveSchema('mysql') as unknown as Record<string, unknown>;
    await pool.query(mysqlCreateTable(tables.meshcoreNodes));
    repo = new MeshCoreRepository(drizzleMysql(pool, { schema, mode: 'default' }) as never, 'mysql');
  }, 60_000);
  afterAll(async () => {
    await cleanupDb?.();
  });
  beforeEach(async () => {
    await pool.query('DELETE FROM meshcore_nodes');
  });

  shared(() => repo);
});
