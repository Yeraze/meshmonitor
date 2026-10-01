/**
 * MeshCoreRepository.findNodesByPublicKeyPrefix (#5500) on SQLite, PostgreSQL
 * and MySQL. A Repeater's `neighbors` CLI reports only an 8-hex key prefix;
 * this lookup finds the candidate full keys across ALL sources, case-blind.
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

const K1 = 'abcd1234' + '1'.repeat(56);
const K2 = 'abcd1234' + '2'.repeat(56);
const K3 = 'ef015678' + '3'.repeat(56);

function sharedPrefixLookup(getRepo: () => MeshCoreRepository) {
  it('matches across sources and ignores case', async () => {
    const repo = getRepo();
    await repo.upsertNode({ publicKey: K1, name: 'Hilltop', advType: 2 }, 'src-a');
    await repo.upsertNode({ publicKey: K1.toUpperCase(), name: 'Hilltop (b)' }, 'src-b');
    await repo.upsertNode({ publicKey: K3, name: 'Valley' }, 'src-a');

    const rows = await repo.findNodesByPublicKeyPrefix('ABCD1234');
    expect(rows.map((r) => `${r.sourceId}:${r.publicKey.toLowerCase()}`).sort()).toEqual([
      `src-a:${K1}`,
      `src-b:${K1}`,
    ]);
    expect(rows.find((r) => r.sourceId === 'src-a')?.name).toBe('Hilltop');
  });

  it('returns every distinct key sharing the prefix (the caller treats it as ambiguous)', async () => {
    const repo = getRepo();
    await repo.upsertNode({ publicKey: K1 }, 'src-a');
    await repo.upsertNode({ publicKey: K2 }, 'src-a');
    const keys = new Set((await repo.findNodesByPublicKeyPrefix('abcd1234')).map((r) => r.publicKey));
    expect(keys).toEqual(new Set([K1, K2]));
  });

  it('matches nothing for no hit, or for non-hex / wildcard input', async () => {
    const repo = getRepo();
    await repo.upsertNode({ publicKey: K1 }, 'src-a');
    expect(await repo.findNodesByPublicKeyPrefix('99999999')).toEqual([]);
    expect(await repo.findNodesByPublicKeyPrefix('%')).toEqual([]);
    expect(await repo.findNodesByPublicKeyPrefix('ab_d')).toEqual([]);
    expect(await repo.findNodesByPublicKeyPrefix('')).toEqual([]);
  });
}

describe('findNodesByPublicKeyPrefix — SQLite', () => {
  let db: Database.Database;
  let repo: MeshCoreRepository;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    repo = new MeshCoreRepository(t.db, 'sqlite');
  });
  afterEach(() => db.close());

  sharedPrefixLookup(() => repo);
});

describe.skipIf(!postgresAvailable)('findNodesByPublicKeyPrefix — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanupDb: (() => Promise<void>) | undefined;
  let repo: MeshCoreRepository;

  beforeAll(async () => {
    ({ pool, cleanup: cleanupDb } = await createIsolatedPostgresDatabase('mcprefix'));
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

  sharedPrefixLookup(() => repo);
});

describe.skipIf(!mysqlAvailable)('findNodesByPublicKeyPrefix — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanupDb: (() => Promise<void>) | undefined;
  let repo: MeshCoreRepository;

  beforeAll(async () => {
    ({ pool, cleanup: cleanupDb } = await createIsolatedMysqlDatabase('mcprefix'));
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

  sharedPrefixLookup(() => repo);
});
