/**
 * SolarIrradianceRepository on SQLite, PostgreSQL and MySQL (#6523).
 *
 * Tables come from the real migration-245 runners, run twice to prove
 * idempotency. PG/MySQL suites own isolated databases and `skipIf` without the
 * test containers — confirm via `numPendingTests`, not `success` alone.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import type pg from 'pg';
import type mysql from 'mysql2/promise';
import * as schema from '../schema/index.js';
import { SolarIrradianceRepository } from './solarIrradiance.js';
import {
  migration as migration245,
  runMigration245Postgres,
  runMigration245Mysql,
} from '../../server/migrations/245_create_solar_irradiance.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from './test-utils.js';

const H = 3600;
const T0 = 1_795_305_600;

function rows(from: number, count: number, sw: number) {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: from + i * H,
    shortwaveRadiation: sw + i,
    cloudCover: i % 2 === 0 ? 50 : null,
  }));
}

function runSharedTests(getRepo: () => SolarIrradianceRepository) {
  it('replaceCellRows stores rows and getCellRange reads them back as numbers, in order', async () => {
    const repo = getRepo();
    await repo.replaceCellRows('0.1:40.05:-89.95', rows(T0, 3, 100), T0);
    const got = await repo.getCellRange('0.1:40.05:-89.95', T0, T0 + 2 * H);
    expect(got).toEqual([
      { timestamp: T0, shortwaveRadiation: 100, cloudCover: 50 },
      { timestamp: T0 + H, shortwaveRadiation: 101, cloudCover: null },
      { timestamp: T0 + 2 * H, shortwaveRadiation: 102, cloudCover: 50 },
    ]);
    expect(typeof got[0].timestamp).toBe('number');
  });

  it('a refresh replaces the overlapping window and keeps older rows', async () => {
    const repo = getRepo();
    await repo.replaceCellRows('c', rows(T0, 4, 100), T0);
    await repo.replaceCellRows('c', rows(T0 + 2 * H, 4, 500), T0 + 10);
    const got = await repo.getCellRange('c', T0, T0 + 10 * H);
    expect(got.map(r => r.shortwaveRadiation)).toEqual([100, 101, 500, 501, 502, 503]);
  });

  it('cells are isolated and range bounds are inclusive', async () => {
    const repo = getRepo();
    await repo.replaceCellRows('a', rows(T0, 3, 1), T0);
    await repo.replaceCellRows('b', rows(T0, 3, 9), T0);
    expect((await repo.getCellRange('a', T0 + H, T0 + H)).map(r => r.shortwaveRadiation)).toEqual([2]);
    expect(await repo.getCellRange('missing', T0, T0 + 9 * H)).toEqual([]);
  });

  it('getLastFetchedAt returns the latest fetch per cell and omits unknown cells', async () => {
    const repo = getRepo();
    await repo.replaceCellRows('a', rows(T0, 2, 1), T0);
    await repo.replaceCellRows('a', rows(T0 + 5 * H, 2, 1), T0 + 99);
    await repo.replaceCellRows('b', rows(T0, 2, 1), T0 + 7);
    const last = await repo.getLastFetchedAt(['a', 'b', 'nope']);
    expect(Object.fromEntries(last)).toEqual({ a: T0 + 99, b: T0 + 7 });
    expect((await repo.getLastFetchedAt([])).size).toBe(0);
  });

  it('deleteOlderThan sweeps only rows before the cutoff', async () => {
    const repo = getRepo();
    await repo.replaceCellRows('a', rows(T0, 4, 1), T0);
    await repo.deleteOlderThan(T0 + 2 * H);
    expect((await repo.getCellRange('a', 0, T0 + 9 * H)).map(r => r.timestamp)).toEqual([T0 + 2 * H, T0 + 3 * H]);
  });

  it('inserts more rows than one chunk', async () => {
    const repo = getRepo();
    await repo.replaceCellRows('big', rows(T0, 450, 0), T0);
    expect(await repo.getCellRange('big', 0, T0 + 1000 * H)).toHaveLength(450);
  });
}

describe('SolarIrradianceRepository — SQLite', () => {
  let repo: SolarIrradianceRepository;
  beforeEach(() => {
    const sqlite = new Database(':memory:');
    migration245.up(sqlite);
    migration245.up(sqlite);
    repo = new SolarIrradianceRepository(drizzleSqlite(sqlite, { schema }), 'sqlite');
  });
  runSharedTests(() => repo);
});

describe.skipIf(!postgresAvailable)('SolarIrradianceRepository — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanupDb: (() => Promise<void>) | undefined;
  let repo: SolarIrradianceRepository;

  beforeAll(async () => {
    const isolated = await createIsolatedPostgresDatabase('solarirr');
    pool = isolated.pool;
    cleanupDb = isolated.cleanup;
    const client = await pool.connect();
    try {
      await runMigration245Postgres(client);
      await runMigration245Postgres(client);
    } finally {
      client.release();
    }
    repo = new SolarIrradianceRepository(drizzlePostgres(pool, { schema }), 'postgres');
  });
  afterAll(async () => { await cleanupDb?.(); });
  beforeEach(async () => { await pool.query('TRUNCATE TABLE solar_irradiance'); });
  runSharedTests(() => repo);
});

describe.skipIf(!mysqlAvailable)('SolarIrradianceRepository — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanupDb: (() => Promise<void>) | undefined;
  let repo: SolarIrradianceRepository;

  beforeAll(async () => {
    const isolated = await createIsolatedMysqlDatabase('solarirr');
    pool = isolated.pool;
    cleanupDb = isolated.cleanup;
    await runMigration245Mysql(pool);
    await runMigration245Mysql(pool);
    repo = new SolarIrradianceRepository(drizzleMysql(pool, { schema, mode: 'default' }), 'mysql');
  });
  afterAll(async () => { await cleanupDb?.(); });
  beforeEach(async () => { await pool.query('TRUNCATE TABLE solar_irradiance'); });
  runSharedTests(() => repo);
});
