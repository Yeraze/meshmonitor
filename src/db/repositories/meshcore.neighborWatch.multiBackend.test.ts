/**
 * #6274: MeshCoreRepository neighbour-watch ledger (getNeighborWatch,
 * applyNeighborWatchChanges, pruneNeighborWatch, the baselined marker) and its
 * cleanup on every delete path, on SQLite, PostgreSQL and MySQL. Each PG/MySQL
 * fixture owns an isolated database and skips silently when the containers
 * are down: confirm coverage via `numPendingTests`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import type pg from 'pg';
import type mysql from 'mysql2/promise';
import * as schema from '../schema/index.js';
import { buildActiveSchema } from '../activeSchema.js';
import { MeshCoreRepository, type MeshCoreNeighborWatchRow } from './meshcore.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';
import { postgresCreateTable, mysqlCreateTable } from '../../server/test-helpers/drizzleDdl.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from './test-utils.js';

const R = 'a'.repeat(64);
const N1 = 'b'.repeat(64);
const N2 = 'c'.repeat(64);
const T0 = 1_800_000_000_000;

const row = (k: string, over: Partial<MeshCoreNeighborWatchRow> = {}): MeshCoreNeighborWatchRow => ({
  neighborPublicKey: k,
  state: 'pending',
  firstSeenAt: T0,
  lastHeardAt: T0,
  lastSnr: 4.5,
  sightings: 1,
  ...over,
});

function shared(getRepo: () => MeshCoreRepository) {
  it('upserts by (source, reporter, neighbour), reads back, deletes the listed keys', async () => {
    const repo = getRepo();
    await repo.applyNeighborWatchChanges('src-a', R, [row(N1), row(N2, { state: 'baseline', lastSnr: null })], []);
    let rows = await repo.getNeighborWatch('src-a', R);
    expect(rows.map((r) => r.neighborPublicKey).sort()).toEqual([N1, N2].sort());
    expect(rows.find((r) => r.neighborPublicKey === N2)?.lastSnr).toBeNull();

    await repo.applyNeighborWatchChanges('src-a', R, [row(N1, { lastHeardAt: T0 + 5, sightings: 2, state: 'confirmed' })], [N2]);
    rows = await repo.getNeighborWatch('src-a', R);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ neighborPublicKey: N1, state: 'confirmed', lastHeardAt: T0 + 5, sightings: 2, firstSeenAt: T0 });
  });

  it('is source scoped and refuses a missing sourceId', async () => {
    const repo = getRepo();
    await repo.applyNeighborWatchChanges('src-a', R, [row(N1)], []);
    await repo.applyNeighborWatchChanges('src-b', R, [row(N1, { state: 'baseline' })], []);
    expect((await repo.getNeighborWatch('src-a', R))[0].state).toBe('pending');
    expect((await repo.getNeighborWatch('src-b', R))[0].state).toBe('baseline');
    await expect(repo.getNeighborWatch('', R)).rejects.toThrow(/sourceId/);
    await expect(repo.applyNeighborWatchChanges('', R, [], [])).rejects.toThrow(/sourceId/);
    await expect(repo.pruneNeighborWatch('', 0)).rejects.toThrow(/sourceId/);
  });

  it('prunes rows not heard since the cutoff, on one source only', async () => {
    const repo = getRepo();
    await repo.applyNeighborWatchChanges('src-a', R, [row(N1, { lastHeardAt: T0 }), row(N2, { lastHeardAt: T0 + 1000 })], []);
    await repo.applyNeighborWatchChanges('src-b', R, [row(N1, { lastHeardAt: T0 })], []);
    expect(await repo.pruneNeighborWatch('src-a', T0 + 500)).toBe(1);
    expect((await repo.getNeighborWatch('src-a', R)).map((r) => r.neighborPublicKey)).toEqual([N2]);
    expect(await repo.getNeighborWatch('src-b', R)).toHaveLength(1);
  });

  it('baselined marker: set on an existing node, never written by upsertNode', async () => {
    const repo = getRepo();
    await repo.upsertNode({ publicKey: R, name: 'rep' }, 'src-a');
    expect(await repo.getNeighborWatchBaselinedAt('src-a', R)).toBeNull();
    await repo.setNeighborWatchBaselined('src-a', R, T0);
    expect(await repo.getNeighborWatchBaselinedAt('src-a', R)).toBe(T0);
    expect(await repo.getNeighborWatchBaselinedAt('src-b', R)).toBeNull();
    // A contact sync that spreads a stored row back in must not touch it.
    await repo.upsertNode({ publicKey: R, name: 'rep2', neighborWatchBaselinedAt: null } as never, 'src-a');
    await repo.upsertNode({ publicKey: R, name: 'rep3', neighborWatchBaselinedAt: 5 } as never, 'src-a');
    expect(await repo.getNeighborWatchBaselinedAt('src-a', R)).toBe(T0);
  });

  it('cleanup: node delete, neighbour deletes, purge and source delete all clear the ledger', async () => {
    const repo = getRepo();
    for (const s of ['src-a', 'src-b']) {
      await repo.upsertNode({ publicKey: R, name: 'rep' }, s);
      await repo.setNeighborWatchBaselined(s, R, T0);
      await repo.applyNeighborWatchChanges(s, R, [row(N1)], []);
    }
    await repo.deleteNeighborWatchForReporter('src-a', R);
    expect(await repo.getNeighborWatch('src-a', R)).toHaveLength(0);
    expect(await repo.getNeighborWatch('src-b', R)).toHaveLength(1);

    await repo.applyNeighborWatchChanges('src-a', R, [row(N1)], []);
    await repo.deleteNeighborsForNode('src-a', R);
    expect(await repo.getNeighborWatch('src-a', R)).toHaveLength(0);

    await repo.applyNeighborWatchChanges('src-a', R, [row(N1)], []);
    await repo.deleteAllNeighbors('src-a');
    expect(await repo.getNeighborWatch('src-a', R)).toHaveLength(0);
    expect(await repo.getNeighborWatch('src-b', R)).toHaveLength(1);

    // Purge keeps the node row of a favourite but resets its marker; other source untouched.
    await repo.applyNeighborWatchChanges('src-a', R, [row(N1)], []);
    expect(await repo.deleteNonFavoriteNodes('src-a')).toBe(1);
    expect(await repo.getNeighborWatch('src-a', R)).toHaveLength(0);
    expect(await repo.getNeighborWatch('src-b', R)).toHaveLength(1);
    expect(await repo.getNeighborWatchBaselinedAt('src-b', R)).toBe(T0);

    await repo.deleteNeighborWatchForSource('src-b');
    expect(await repo.getNeighborWatch('src-b', R)).toHaveLength(0);

    await repo.applyNeighborWatchChanges('src-b', R, [row(N1)], []);
    await repo.deleteNode(R, 'src-b');
    expect(await repo.getNeighborWatch('src-b', R)).toHaveLength(0);
  });
}

describe('neighbour watch repo — SQLite', () => {
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

describe.skipIf(!postgresAvailable)('neighbour watch repo — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanupDb: (() => Promise<void>) | undefined;
  let repo: MeshCoreRepository;

  beforeAll(async () => {
    ({ pool, cleanup: cleanupDb } = await createIsolatedPostgresDatabase('mcnbw'));
    const tables = buildActiveSchema('postgres') as unknown as Record<string, unknown>;
    for (const t of [tables.meshcoreNodes, tables.meshcoreNeighbors, tables.meshcoreNeighborWatch]) {
      for (const statement of postgresCreateTable(t).split(';\n')) await pool.query(statement);
    }
    repo = new MeshCoreRepository(drizzlePostgres(pool, { schema }) as never, 'postgres');
  }, 60_000);
  afterAll(async () => {
    await cleanupDb?.();
  });
  beforeEach(async () => {
    await pool.query('DELETE FROM meshcore_nodes');
    await pool.query('DELETE FROM meshcore_neighbor_watch');
    await pool.query('DELETE FROM meshcore_neighbor_info');
  });

  shared(() => repo);
});

describe.skipIf(!mysqlAvailable)('neighbour watch repo — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanupDb: (() => Promise<void>) | undefined;
  let repo: MeshCoreRepository;

  beforeAll(async () => {
    ({ pool, cleanup: cleanupDb } = await createIsolatedMysqlDatabase('mcnbw'));
    const tables = buildActiveSchema('mysql') as unknown as Record<string, unknown>;
    await pool.query(mysqlCreateTable(tables.meshcoreNodes));
    await pool.query(mysqlCreateTable(tables.meshcoreNeighbors));
    await pool.query(mysqlCreateTable(tables.meshcoreNeighborWatch));
    repo = new MeshCoreRepository(drizzleMysql(pool, { schema, mode: 'default' }) as never, 'mysql');
  }, 60_000);
  afterAll(async () => {
    await cleanupDb?.();
  });
  beforeEach(async () => {
    await pool.query('DELETE FROM meshcore_nodes');
    await pool.query('DELETE FROM meshcore_neighbor_watch');
    await pool.query('DELETE FROM meshcore_neighbor_info');
  });

  shared(() => repo);
});
