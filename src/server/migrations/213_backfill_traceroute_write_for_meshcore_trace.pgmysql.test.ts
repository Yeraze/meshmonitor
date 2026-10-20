/**
 * Migration 213 — PostgreSQL / MySQL container behaviour (#5898).
 *
 * Own isolated per-suite database via `createIsolatedPostgresDatabase` /
 * `createIsolatedMysqlDatabase`: `permissions` and `sources` are fixture
 * tables in other suites, and sharing one test database races (CLAUDE.md
 * Multi-Database).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration213Postgres, runMigration213Mysql } from './213_backfill_traceroute_write_for_meshcore_trace.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

interface Row { userId: number; resource: string; sourceId: string | null; canViewOnMap: boolean; canRead: boolean; canWrite: boolean; canDelete: boolean }

/** Shared fixture: user 10 has nodes:write on mc-1 (no traceroute row) and on
 *  mc-2 (read-only traceroute row); user 11 has nodes:write on a Meshtastic
 *  source and a global row; user 12 has nodes read only; user 13 already has
 *  full traceroute access. */
const FIXTURE: Array<[number, string, string | null, boolean, boolean, boolean]> = [
  // userId, resource, sourceId, canViewOnMap, canRead, canWrite
  [10, 'nodes', 'mc-1', false, true, true],
  [10, 'nodes', 'mc-2', false, false, true],
  [10, 'traceroute', 'mc-2', false, true, false],
  [11, 'nodes', 'mt-1', false, true, true],
  [11, 'nodes', null, false, true, true],
  [12, 'nodes', 'mc-1', false, true, false],
  [13, 'nodes', 'mc-1', false, true, true],
  [13, 'traceroute', 'mc-1', true, true, true],
];

function normalise(rows: any[]): Row[] {
  return rows.map((r) => ({
    userId: Number(r.userId),
    resource: r.resource,
    sourceId: r.sourceId,
    canViewOnMap: !!r.canViewOnMap,
    canRead: !!r.canRead,
    canWrite: !!r.canWrite,
    canDelete: !!r.canDelete,
  }));
}

function expectBackfilled(rows: Row[]): void {
  const tr = (u: number, s: string | null) => rows.filter((r) => r.userId === u && r.resource === 'traceroute' && r.sourceId === s);
  expect(tr(10, 'mc-1')).toEqual([
    { userId: 10, resource: 'traceroute', sourceId: 'mc-1', canViewOnMap: false, canRead: false, canWrite: true, canDelete: false },
  ]);
  expect(tr(10, 'mc-2')).toEqual([
    { userId: 10, resource: 'traceroute', sourceId: 'mc-2', canViewOnMap: false, canRead: true, canWrite: true, canDelete: false },
  ]);
  expect(rows.filter((r) => r.userId === 11 && r.resource === 'traceroute')).toEqual([]);
  expect(rows.filter((r) => r.userId === 12 && r.resource === 'traceroute')).toEqual([]);
  expect(tr(13, 'mc-1')).toEqual([
    { userId: 13, resource: 'traceroute', sourceId: 'mc-1', canViewOnMap: true, canRead: true, canWrite: true, canDelete: false },
  ]);
  // Nothing else moved: 8 fixture rows + 1 insert.
  expect(rows).toHaveLength(FIXTURE.length + 1);
}

describe.skipIf(!postgresAvailable)('migration 213 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig213'));
  }, 30_000);

  afterAll(async () => {
    await cleanup?.();
  });

  beforeEach(async () => {
    await pool.query('DROP TABLE IF EXISTS permissions CASCADE');
    await pool.query('DROP TABLE IF EXISTS sources CASCADE');
    await pool.query(`CREATE TABLE sources (id TEXT PRIMARY KEY, type TEXT NOT NULL)`);
    await pool.query(`
      CREATE TABLE permissions (
        id SERIAL PRIMARY KEY,
        "userId" INTEGER NOT NULL,
        resource TEXT NOT NULL,
        "canViewOnMap" BOOLEAN NOT NULL DEFAULT false,
        "canRead" BOOLEAN NOT NULL DEFAULT false,
        "canWrite" BOOLEAN NOT NULL DEFAULT false,
        "canDelete" BOOLEAN NOT NULL DEFAULT false,
        "grantedAt" BIGINT,
        "grantedBy" INTEGER,
        "sourceId" TEXT
      )
    `);
    await pool.query(`CREATE UNIQUE INDEX permissions_user_resource_source ON permissions ("userId", resource, "sourceId")`);
    await pool.query(`INSERT INTO sources (id, type) VALUES ('mc-1','meshcore'),('mc-2','meshcore'),('mt-1','meshtastic_tcp')`);
    for (const [u, res, s, m, r, w] of FIXTURE) {
      await pool.query(
        `INSERT INTO permissions ("userId", resource, "sourceId", "canViewOnMap", "canRead", "canWrite", "grantedAt") VALUES ($1,$2,$3,$4,$5,$6,1)`,
        [u, res, s, m, r, w],
      );
    }
  });

  const readAll = async () =>
    normalise((await pool.query(`SELECT "userId", resource, "sourceId", "canViewOnMap", "canRead", "canWrite", "canDelete" FROM permissions ORDER BY id`)).rows);

  it('backfills traceroute:write, never reduces, and is idempotent', async () => {
    const client = await pool.connect();
    try {
      await runMigration213Postgres(client);
      const once = await readAll();
      expectBackfilled(once);
      await runMigration213Postgres(client);
      expect(await readAll()).toEqual(once);
    } finally {
      client.release();
    }
  });
});

describe.skipIf(!mysqlAvailable)('migration 213 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig213'));
  }, 30_000);

  afterAll(async () => {
    await cleanup?.();
  });

  beforeEach(async () => {
    await pool.query('DROP TABLE IF EXISTS permissions');
    await pool.query('DROP TABLE IF EXISTS sources');
    await pool.query(`CREATE TABLE sources (id VARCHAR(36) PRIMARY KEY, type VARCHAR(32) NOT NULL)`);
    await pool.query(`
      CREATE TABLE permissions (
        id SERIAL PRIMARY KEY,
        userId INT NOT NULL,
        resource VARCHAR(64) NOT NULL,
        canViewOnMap BOOLEAN NOT NULL DEFAULT false,
        canRead BOOLEAN NOT NULL DEFAULT false,
        canWrite BOOLEAN NOT NULL DEFAULT false,
        canDelete BOOLEAN NOT NULL DEFAULT false,
        grantedAt BIGINT,
        grantedBy INT,
        sourceId VARCHAR(36),
        UNIQUE KEY permissions_user_resource_source (userId, resource, sourceId)
      )
    `);
    await pool.query(`INSERT INTO sources (id, type) VALUES ('mc-1','meshcore'),('mc-2','meshcore'),('mt-1','meshtastic_tcp')`);
    for (const [u, res, s, m, r, w] of FIXTURE) {
      await pool.query(
        `INSERT INTO permissions (userId, resource, sourceId, canViewOnMap, canRead, canWrite, grantedAt) VALUES (?,?,?,?,?,?,1)`,
        [u, res, s, m, r, w],
      );
    }
  });

  const readAll = async () => {
    const [rows] = await pool.query(`SELECT userId, resource, sourceId, canViewOnMap, canRead, canWrite, canDelete FROM permissions ORDER BY id`);
    return normalise(rows as any[]);
  };

  it('backfills traceroute:write, never reduces, and is idempotent', async () => {
    await runMigration213Mysql(pool);
    const once = await readAll();
    expectBackfilled(once);
    await runMigration213Mysql(pool);
    expect(await readAll()).toEqual(once);
  });
});
