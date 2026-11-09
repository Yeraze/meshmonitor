/**
 * P7a (#6254): MeshCoreRepository.getDeadNodes and the tri-state
 * `advertSignatureVerified` column (null clears) on SQLite, PostgreSQL and MySQL.
 *
 * The PG/MySQL halves build `meshcore_nodes` from the Drizzle schema in their
 * own isolated database, and skip silently when the containers are down —
 * confirm coverage via `numPendingTests`.
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
const C = 'c'.repeat(64);
const D = 'd'.repeat(64);
const NOW = 2_000_000_000_000;
const DAY = 86_400_000;

function shared(getRepo: () => MeshCoreRepository) {
  it('getDeadNodes uses an ms cutoff, includes never-heard, scopes by source', async () => {
    const repo = getRepo();
    await repo.upsertNode({ publicKey: A, lastHeard: NOW - 20 * DAY }, 'src-a');
    await repo.upsertNode({ publicKey: B, lastHeard: NOW - 1 * DAY }, 'src-a');
    await repo.upsertNode({ publicKey: C }, 'src-a'); // never heard
    await repo.upsertNode({ publicKey: D, lastHeard: NOW - 30 * DAY }, 'src-b');
    const cutoff = NOW - 14 * DAY;

    const withNever = await repo.getDeadNodes('src-a', cutoff, { includeNeverHeard: true });
    expect(withNever.map((n) => n.publicKey).sort()).toEqual([A, C].sort());

    const heardOnly = await repo.getDeadNodes('src-a', cutoff);
    expect(heardOnly.map((n) => n.publicKey)).toEqual([A]);

    const other = await repo.getDeadNodes('src-b', cutoff, { includeNeverHeard: true });
    expect(other.map((n) => n.publicKey)).toEqual([D]);
    expect(await repo.getDeadNodes('', cutoff)).toEqual([]);
  });

  it('advertSignatureVerified is tri-state: true/false stick, undefined keeps, null clears', async () => {
    const repo = getRepo();
    const get = async () => (await repo.getNodeByPublicKeyAndSource(A, 'src-a'))?.advertSignatureVerified;
    await repo.upsertNode({ publicKey: A, advertSignatureVerified: true }, 'src-a');
    expect(Boolean(await get())).toBe(true);
    await repo.upsertNode({ publicKey: A, name: 'x' }, 'src-a');
    expect(Boolean(await get())).toBe(true);
    await repo.upsertNode({ publicKey: A, advertSignatureVerified: false }, 'src-a');
    const f = await get();
    expect(f === false || f === 0).toBe(true);
    await repo.upsertNode({ publicKey: A, advertSignatureVerified: null }, 'src-a');
    expect(await get()).toBeNull();
  });
}

describe('getDeadNodes / signature tri-state — SQLite', () => {
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

describe.skipIf(!postgresAvailable)('getDeadNodes / signature tri-state — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanupDb: (() => Promise<void>) | undefined;
  let repo: MeshCoreRepository;

  beforeAll(async () => {
    ({ pool, cleanup: cleanupDb } = await createIsolatedPostgresDatabase('mcdead'));
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

describe.skipIf(!mysqlAvailable)('getDeadNodes / signature tri-state — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanupDb: (() => Promise<void>) | undefined;
  let repo: MeshCoreRepository;

  beforeAll(async () => {
    ({ pool, cleanup: cleanupDb } = await createIsolatedMysqlDatabase('mcdead'));
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
