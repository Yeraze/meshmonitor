/**
 * Migration 132 — PostgreSQL / MySQL behaviour (#4416, WP2).
 *
 * Two halves, per CLAUDE.md guidance for schema/migration work:
 *
 *   1. Fake-client half (always runs): pins the #4233 batching guard — reads
 *      are single round trips, inserts are batched (not one round-trip per
 *      row), and the exact dialect SQL shape (quoted camelCase columns +
 *      ON CONFLICT DO NOTHING on PostgreSQL, INSERT IGNORE on MySQL).
 *      Modeled on 131_seed_per_source_node_display.pgmysql.test.ts.
 *
 *   2. Container half (`describe.skipIf(!postgresAvailable/!mysqlAvailable)`):
 *      runs the REAL migration function against the live test containers
 *      (localhost:5433 / :3307) with the same 8-user fixture as the SQLite
 *      upgrade-proof test, and asserts the same before/after identity via the
 *      REAL `DatabaseService.prototype.checkPermissionAsync` (invoked against
 *      a minimal object exposing only `.auth`, since building a full
 *      PostgreSQL/MySQL-backed DatabaseService singleton per test file is not
 *      necessary — `checkPermissionAsync` touches nothing but `this.auth`).
 *      A silent skip here still reports `success: true` at the suite level —
 *      confirm via `numPendingTests` in the JSON reporter, not just the
 *      pass/fail summary.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import * as schema from '../../db/schema/index.js';
import { AuthRepository } from '../../db/repositories/auth.js';
import { DatabaseService } from '../../services/database.js';
import {
  runMigration132Postgres,
  runMigration132Mysql,
} from './132_fan_out_settings_permissions.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

function sourceRows(n: number): Array<{ id: string }> {
  return Array.from({ length: n }, (_, i) => ({ id: `src-${i}` }));
}

// ---------------------------------------------------------------------------
// Fake-client half
// ---------------------------------------------------------------------------

function fakePgClient(opts: { sources: Array<{ id: string }>; settingsRows?: any[] }) {
  const queries: { sql: string; params?: any[] }[] = [];
  return {
    queries,
    query: vi.fn(async (sql: string, params?: any[]) => {
      queries.push({ sql, params });
      const s = sql.trimStart();
      if (s.startsWith('SELECT id FROM sources')) return { rows: opts.sources };
      if (s.startsWith('SELECT "userId"')) return { rows: opts.settingsRows ?? [] };
      return { rows: [], rowCount: 0 };
    }),
  };
}

function fakeMysqlPool(opts: { sources: Array<{ id: string }>; settingsRows?: any[] }) {
  const queries: { sql: string; params?: any[] }[] = [];
  const conn = {
    query: vi.fn(async (sql: string, params?: any[]) => {
      queries.push({ sql, params });
      const s = sql.trimStart();
      if (s.startsWith('SELECT id FROM sources')) return [opts.sources];
      if (s.startsWith('SELECT userId')) return [opts.settingsRows ?? []];
      return [{}];
    }),
    beginTransaction: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}),
    release: vi.fn(),
  };
  return { queries, conn, getConnection: async () => conn };
}

const isSelectSources = (q: { sql: string }) => q.sql.trimStart().startsWith('SELECT id FROM sources');
const isSelectPermissions = (q: { sql: string }) => q.sql.includes('FROM permissions') && q.sql.trimStart().startsWith('SELECT');
const isInsert = (q: { sql: string }) => q.sql.trimStart().startsWith('INSERT');
const isUpdate = (q: { sql: string }) => q.sql.trimStart().startsWith('UPDATE');
const isDelete = (q: { sql: string }) => q.sql.trimStart().startsWith('DELETE');
const isBegin = (q: { sql: string }) => q.sql.trim() === 'BEGIN';

/** A single global settings row per user, all read+write. */
function globalSettingsRows(userIds: number[]): any[] {
  return userIds.map((userId) => ({
    userId, sourceId: null,
    canViewOnMap: false, canRead: true, canWrite: true, canDelete: false,
    grantedAt: 1000, grantedBy: null,
  }));
}

describe('migration 132 — PostgreSQL (fake client)', () => {
  it('reads sources and settings rows in exactly one round trip each', async () => {
    const client = fakePgClient({ sources: sourceRows(3), settingsRows: globalSettingsRows([1, 2]) });
    await runMigration132Postgres(client as any);

    expect(client.queries.filter(isSelectSources)).toHaveLength(1);
    expect(client.queries.filter(isSelectPermissions)).toHaveLength(1);
  });

  it('batches inserts instead of one round-trip per row (#4233)', async () => {
    // 150 users x 3 sources = 450 rows -> ceil(450 / 200) = 3 batches.
    const userIds = Array.from({ length: 150 }, (_, i) => i + 1);
    const client = fakePgClient({ sources: sourceRows(3), settingsRows: globalSettingsRows(userIds) });
    await runMigration132Postgres(client as any);

    const inserts = client.queries.filter(isInsert);
    expect(inserts).toHaveLength(3);
  });

  it('uses quoted camelCase columns and ON CONFLICT DO NOTHING', async () => {
    const client = fakePgClient({ sources: sourceRows(1), settingsRows: globalSettingsRows([1]) });
    await runMigration132Postgres(client as any);

    const inserts = client.queries.filter(isInsert);
    expect(inserts.length).toBeGreaterThan(0);
    for (const ins of inserts) {
      expect(ins.sql).toContain('"userId"');
      expect(ins.sql).toContain('"sourceId"');
      expect(ins.sql).toContain('ON CONFLICT DO NOTHING');
    }
  });

  it('groups the widen-UPDATE by flag combination, not per user', async () => {
    // 3 users, all identical flags (read+write) -> exactly 1 UPDATE statement,
    // not 3.
    const client = fakePgClient({ sources: sourceRows(1), settingsRows: globalSettingsRows([1, 2, 3]) });
    await runMigration132Postgres(client as any);

    expect(client.queries.filter(isUpdate)).toHaveLength(1);
  });

  it('deletes NULL-scoped settings rows last, inside the same transaction', async () => {
    const client = fakePgClient({ sources: sourceRows(1), settingsRows: globalSettingsRows([1]) });
    await runMigration132Postgres(client as any);

    const order = client.queries.map((q) => q.sql.trimStart().split(/\s+/)[0]);
    const beginIdx = order.indexOf('BEGIN');
    const deleteIdx = order.indexOf('DELETE');
    const insertIdx = order.indexOf('INSERT');
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(insertIdx).toBeGreaterThan(beginIdx);
    expect(deleteIdx).toBeGreaterThan(insertIdx); // delete strictly after insert
  });

  it('is a no-op with no sources: no BEGIN, no INSERT, no DELETE', async () => {
    const client = fakePgClient({ sources: [], settingsRows: globalSettingsRows([1]) });
    await runMigration132Postgres(client as any);

    expect(client.queries.filter(isInsert)).toHaveLength(0);
    expect(client.queries.filter(isDelete)).toHaveLength(0);
    expect(client.queries.filter(isBegin)).toHaveLength(0);
  });

  it('is a no-op with no settings rows: no BEGIN, no writes', async () => {
    const client = fakePgClient({ sources: sourceRows(3), settingsRows: [] });
    await runMigration132Postgres(client as any);

    expect(client.queries.filter(isInsert)).toHaveLength(0);
    expect(client.queries.filter(isBegin)).toHaveLength(0);
  });

  it('when sources table is missing, logs and returns without throwing', async () => {
    const client = {
      queries: [] as any[],
      query: vi.fn(async () => { throw new Error('relation "sources" does not exist'); }),
    };
    await expect(runMigration132Postgres(client as any)).resolves.toBeUndefined();
  });

  it('when permissions table is missing, logs and returns without throwing', async () => {
    let call = 0;
    const client = {
      queries: [] as any[],
      query: vi.fn(async () => {
        call++;
        if (call === 1) return { rows: sourceRows(2) }; // sources ok
        throw new Error('relation "permissions" does not exist');
      }),
    };
    await expect(runMigration132Postgres(client as any)).resolves.toBeUndefined();
  });
});

describe('migration 132 — MySQL (fake pool)', () => {
  it('reads sources and settings rows in exactly one round trip each', async () => {
    const pool = fakeMysqlPool({ sources: sourceRows(3), settingsRows: globalSettingsRows([1, 2]) });
    await runMigration132Mysql(pool as any);

    expect(pool.queries.filter(isSelectSources)).toHaveLength(1);
    expect(pool.queries.filter(isSelectPermissions)).toHaveLength(1);
    expect(pool.conn.release).toHaveBeenCalled();
  });

  it('batches inserts instead of one round-trip per row (#4233)', async () => {
    const userIds = Array.from({ length: 150 }, (_, i) => i + 1);
    const pool = fakeMysqlPool({ sources: sourceRows(3), settingsRows: globalSettingsRows(userIds) });
    await runMigration132Mysql(pool as any);

    const inserts = pool.queries.filter(isInsert);
    expect(inserts).toHaveLength(3);
    expect(pool.conn.commit).toHaveBeenCalled();
  });

  it('uses INSERT IGNORE', async () => {
    const pool = fakeMysqlPool({ sources: sourceRows(1), settingsRows: globalSettingsRows([1]) });
    await runMigration132Mysql(pool as any);

    const inserts = pool.queries.filter(isInsert);
    expect(inserts.length).toBeGreaterThan(0);
    for (const ins of inserts) {
      expect(ins.sql).toContain('INSERT IGNORE');
    }
  });

  it('groups the widen-UPDATE by flag combination, not per user', async () => {
    const pool = fakeMysqlPool({ sources: sourceRows(1), settingsRows: globalSettingsRows([1, 2, 3]) });
    await runMigration132Mysql(pool as any);

    expect(pool.queries.filter(isUpdate)).toHaveLength(1);
  });

  it('is a no-op with no sources: no beginTransaction, no INSERT, no DELETE', async () => {
    const pool = fakeMysqlPool({ sources: [], settingsRows: globalSettingsRows([1]) });
    await runMigration132Mysql(pool as any);

    expect(pool.queries.filter(isInsert)).toHaveLength(0);
    expect(pool.queries.filter(isDelete)).toHaveLength(0);
    expect(pool.conn.beginTransaction).not.toHaveBeenCalled();
    expect(pool.conn.release).toHaveBeenCalled();
  });

  it('is a no-op with no settings rows: no beginTransaction, no writes', async () => {
    const pool = fakeMysqlPool({ sources: sourceRows(3), settingsRows: [] });
    await runMigration132Mysql(pool as any);

    expect(pool.queries.filter(isInsert)).toHaveLength(0);
    expect(pool.conn.beginTransaction).not.toHaveBeenCalled();
  });

  it('when sources table is missing, logs and returns without throwing', async () => {
    const conn = {
      query: vi.fn(async () => { throw new Error("Table 'meshmonitor.sources' doesn't exist"); }),
      beginTransaction: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}),
      release: vi.fn(),
    };
    const pool = { getConnection: async () => conn };
    await expect(runMigration132Mysql(pool as any)).resolves.toBeUndefined();
    expect(conn.release).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Container half — real PostgreSQL / MySQL test containers.
//
// Same fixture as 132_fan_out_settings_permissions.test.ts (SQLite): 3
// sources, 8 users covering the common case / read-only / all-false / no-row
// / mixed-scope / historic-per-source-only / admin / anonymous-shaped shapes.
// Assertions mirror the SQLite file: effective-access identity (BEFORE via
// the same frozen oracle, AFTER via the REAL checkPermissionAsync), NULL rows
// removed, row count, nothing-else-touched, idempotency.
// ---------------------------------------------------------------------------

interface RawRow {
  userId: number; resource: string; sourceId: string | null;
  canViewOnMap: boolean; canRead: boolean; canWrite: boolean;
}

/**
 * FROZEN pre-#4416 oracle — do NOT sync this with checkPermissionAsync.
 *
 * This is a deliberate re-implementation of the NON-sourcey branch as it behaved
 * BEFORE 'settings' became a sourcey resource (services/database.ts:4392+, pre-#4416):
 * the OR across every settings row the user has, regardless of that row's scope.
 *
 * It exists because one binary cannot run both classifications — the "before" behavior
 * is gone from the source tree by the time this test executes, so the only way to prove
 * the migration preserved effective access is to model the old rule here and compare.
 *
 * If you find yourself updating this to match current checkPermissionAsync: STOP. That
 * makes the test compare the new behavior against itself and it will measure nothing.
 * If checkPermissionAsync's sourcey branch changes, this block still must not move.
 * See PER_SOURCE_NODE_DISPLAY_PHASE6_SPEC.md §3.2 and WP2 assertion 1.
 *
 * Duplicated verbatim from the SQLite test file rather than imported — each
 * migration test file is self-contained (matches the repo's existing
 * per-file pattern, e.g. 131's SQLite and pgmysql test files each define
 * their own fixtures).
 */
function frozenPreFlipCheck(isAdmin: boolean, rows: RawRow[], action: 'read' | 'write'): boolean {
  if (isAdmin) return true;
  const check = (r: RawRow) => (action === 'read' ? r.canRead : r.canWrite);
  for (const r of rows) if (!r.sourceId && check(r)) return true;
  for (const r of rows) if (r.sourceId && check(r)) return true;
  return false;
}

const PG_CREATE = `
  DROP TABLE IF EXISTS permissions CASCADE;
  DROP TABLE IF EXISTS sources CASCADE;
  DROP TABLE IF EXISTS users CASCADE;
  CREATE TABLE sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    config TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "createdBy" INTEGER
  );
  CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    "passwordHash" TEXT,
    email TEXT,
    "displayName" TEXT,
    "authMethod" TEXT NOT NULL DEFAULT 'local',
    "oidcSubject" TEXT UNIQUE,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "passwordLocked" BOOLEAN DEFAULT false,
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "mfaSecret" TEXT,
    "mfaBackupCodes" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "lastLoginAt" BIGINT
  );
  CREATE TABLE permissions (
    id SERIAL PRIMARY KEY,
    "userId" INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    resource TEXT NOT NULL,
    "canViewOnMap" BOOLEAN NOT NULL DEFAULT false,
    "canRead" BOOLEAN NOT NULL DEFAULT false,
    "canWrite" BOOLEAN NOT NULL DEFAULT false,
    "canDelete" BOOLEAN NOT NULL DEFAULT false,
    "grantedAt" BIGINT,
    "grantedBy" INTEGER,
    "sourceId" TEXT
  );
  CREATE UNIQUE INDEX permissions_user_resource_source_uniq ON permissions("userId", resource, "sourceId");
`;

const MYSQL_CREATE = `
  SET FOREIGN_KEY_CHECKS = 0;
  DROP TABLE IF EXISTS permissions;
  DROP TABLE IF EXISTS sources;
  DROP TABLE IF EXISTS users;
  SET FOREIGN_KEY_CHECKS = 1;
  CREATE TABLE sources (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(64) NOT NULL,
    config TEXT NOT NULL,
    enabled TINYINT NOT NULL DEFAULT 1,
    createdAt BIGINT NOT NULL,
    updatedAt BIGINT NOT NULL,
    createdBy INT
  );
  CREATE TABLE users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(255) NOT NULL UNIQUE,
    passwordHash VARCHAR(255),
    email VARCHAR(255),
    displayName VARCHAR(255),
    authMethod VARCHAR(32) NOT NULL DEFAULT 'local',
    oidcSubject VARCHAR(255) UNIQUE,
    isAdmin BOOLEAN NOT NULL DEFAULT false,
    isActive BOOLEAN NOT NULL DEFAULT true,
    passwordLocked BOOLEAN DEFAULT false,
    mfaEnabled BOOLEAN NOT NULL DEFAULT false,
    mfaSecret TEXT,
    mfaBackupCodes TEXT,
    createdAt BIGINT NOT NULL,
    updatedAt BIGINT NOT NULL,
    lastLoginAt BIGINT
  );
  CREATE TABLE permissions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    userId INT NOT NULL,
    resource VARCHAR(64) NOT NULL,
    canViewOnMap BOOLEAN NOT NULL DEFAULT false,
    canRead BOOLEAN NOT NULL DEFAULT false,
    canWrite BOOLEAN NOT NULL DEFAULT false,
    canDelete BOOLEAN NOT NULL DEFAULT false,
    grantedAt BIGINT,
    grantedBy INT,
    sourceId VARCHAR(64),
    UNIQUE KEY permissions_user_resource_source_uniq (userId, resource, sourceId),
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
  );
`;

/** Minimal object exposing only `.auth`, so the REAL production
 * `checkPermissionAsync` (which touches nothing but `this.auth`) can run
 * against an AuthRepository bound to whichever backend this test file is
 * driving, without constructing a full backend-specific DatabaseService. */
function realCheckPermissionAsyncFor(authRepo: AuthRepository) {
  const fake = Object.create(DatabaseService.prototype) as DatabaseService;
  (fake as any).authRepo = authRepo;
  return (userId: number, resource: string, action: string, sourceId?: string) =>
    fake.checkPermissionAsync(userId, resource, action, sourceId);
}

describe.skipIf(!postgresAvailable)('migration 132 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;
  let authRepo: AuthRepository;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig132'));
    await pool.query(PG_CREATE);
    const drizzleDb = drizzlePostgres(pool, { schema });
    authRepo = new AuthRepository(drizzleDb as any, 'postgres');
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('preserves effective settings access exactly across the fan-out (the deliverable)', async () => {
    const check = realCheckPermissionAsyncFor(authRepo);
    const now = Date.now();

    async function makeUser(username: string, isAdmin = false): Promise<number> {
      const { rows } = await pool.query(
        `INSERT INTO users (username, "authMethod", "isAdmin", "createdAt", "updatedAt") VALUES ($1, 'local', $2, $3, $3) RETURNING id`,
        [username, isAdmin, now],
      );
      return rows[0].id;
    }
    async function makeSource(id: string): Promise<void> {
      await pool.query(
        `INSERT INTO sources (id, name, type, config, enabled, "createdAt", "updatedAt") VALUES ($1, $1, 'meshtastic_tcp', '{}', true, $2, $2)`,
        [id, now],
      );
    }
    async function grant(userId: number, resource: string, sourceId: string | null, canRead: boolean, canWrite: boolean): Promise<void> {
      await pool.query(
        `INSERT INTO permissions ("userId", resource, "sourceId", "canRead", "canWrite") VALUES ($1, $2, $3, $4, $5)`,
        [userId, resource, sourceId, canRead, canWrite],
      );
    }

    const sA = `pg-src-a-${now}`, sB = `pg-src-b-${now}`, sC = `pg-src-c-${now}`;
    await makeSource(sA); await makeSource(sB); await makeSource(sC);

    const u1 = await makeUser(`pg_u1_${now}`);
    const u2 = await makeUser(`pg_u2_${now}`);
    const u3 = await makeUser(`pg_u3_${now}`);
    const u4 = await makeUser(`pg_u4_${now}`);
    const u5 = await makeUser(`pg_u5_${now}`);
    const u6 = await makeUser(`pg_u6_${now}`);
    const u7 = await makeUser(`pg_u7_${now}`, true);
    const u8 = await makeUser(`pg_u8_anon_${now}`); // anonymous-shaped: no settings row

    const isAdminByUser = new Map<number, boolean>([[u1, false], [u2, false], [u3, false], [u4, false], [u5, false], [u6, false], [u7, true], [u8, false]]);
    const rawRows: RawRow[] = [];

    await grant(u1, 'settings', null, true, true);
    rawRows.push({ userId: u1, resource: 'settings', sourceId: null, canViewOnMap: false, canRead: true, canWrite: true });

    await grant(u2, 'settings', null, true, false);
    rawRows.push({ userId: u2, resource: 'settings', sourceId: null, canViewOnMap: false, canRead: true, canWrite: false });

    await grant(u3, 'settings', null, false, false);
    rawRows.push({ userId: u3, resource: 'settings', sourceId: null, canViewOnMap: false, canRead: false, canWrite: false });

    // u4: no settings row.

    await grant(u5, 'settings', null, true, false);
    rawRows.push({ userId: u5, resource: 'settings', sourceId: null, canViewOnMap: false, canRead: true, canWrite: false });
    await grant(u5, 'settings', sA, false, true);
    rawRows.push({ userId: u5, resource: 'settings', sourceId: sA, canViewOnMap: false, canRead: false, canWrite: true });

    await grant(u6, 'settings', sA, false, true);
    rawRows.push({ userId: u6, resource: 'settings', sourceId: sA, canViewOnMap: false, canRead: false, canWrite: true });

    await grant(u7, 'settings', null, true, true);
    rawRows.push({ userId: u7, resource: 'settings', sourceId: null, canViewOnMap: false, canRead: true, canWrite: true });

    // u8: no settings row.

    // Non-settings rows for the "nothing else touched" assertion.
    await grant(u1, 'nodes', sA, true, false);
    await grant(u2, 'themes', null, true, true);
    const { rows: nonSettingsBefore } = await pool.query(`SELECT * FROM permissions WHERE resource != 'settings' ORDER BY id`);

    const users = { u1, u2, u3, u4, u5, u6, u7, u8 };
    const scopes: Array<string | undefined> = [sA, sB, sC, undefined];
    const actions: Array<'read' | 'write'> = ['read', 'write'];

    const before: Record<string, boolean> = {};
    for (const [label, userId] of Object.entries(users)) {
      const userRows = rawRows.filter((r) => r.userId === userId);
      for (const action of actions) for (const scope of scopes) {
        before[`${label}:${action}:${scope ?? 'undefined'}`] = frozenPreFlipCheck(isAdminByUser.get(userId)!, userRows, action);
      }
    }

    // ---- Run the REAL migration function ----
    const client = await pool.connect();
    try {
      await runMigration132Postgres(client);
    } finally {
      client.release();
    }

    const after: Record<string, boolean> = {};
    for (const [label, userId] of Object.entries(users)) {
      for (const action of actions) for (const scope of scopes) {
        after[`${label}:${action}:${scope ?? 'undefined'}`] = await check(userId, 'settings', action, scope);
      }
    }

    expect(after).toEqual(before);

    // Individual checks so admin bypass isn't hiding a broken u1/u2/u5/u6.
    expect(after['u1:read:undefined']).toBe(true);
    expect(after['u1:write:undefined']).toBe(true);
    expect(after['u2:read:undefined']).toBe(true);
    expect(after['u2:write:undefined']).toBe(false);
    expect(after['u5:read:undefined']).toBe(true);
    expect(after['u5:write:undefined']).toBe(true);
    expect(after['u6:read:undefined']).toBe(false);
    expect(after['u6:write:undefined']).toBe(true);

    // NULL rows removed.
    const { rows: nullRows } = await pool.query(`SELECT COUNT(*)::int AS c FROM permissions WHERE resource = 'settings' AND "sourceId" IS NULL`);
    expect(nullRows[0].c).toBe(0);

    // Row count: 5 users with real access (u1,u2,u5,u6,u7) x 3 sources.
    const { rows: settingsAfter } = await pool.query(`SELECT * FROM permissions WHERE resource = 'settings'`);
    expect(settingsAfter.length).toBe(5 * 3);

    // Nothing else touched.
    const { rows: nonSettingsAfter } = await pool.query(`SELECT * FROM permissions WHERE resource != 'settings' ORDER BY id`);
    expect(nonSettingsAfter).toEqual(nonSettingsBefore);

    // Idempotency: run again, byte-identical.
    const { rows: allBefore } = await pool.query(`SELECT * FROM permissions ORDER BY id`);
    const client2 = await pool.connect();
    try {
      await runMigration132Postgres(client2);
    } finally {
      client2.release();
    }
    const { rows: allAfter } = await pool.query(`SELECT * FROM permissions ORDER BY id`);
    expect(allAfter).toEqual(allBefore);
  });
});

describe.skipIf(!mysqlAvailable)('migration 132 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;
  let authRepo: AuthRepository;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig132'));
    for (const stmt of MYSQL_CREATE.split(';').map((s) => s.trim()).filter(Boolean)) {
      await pool.query(stmt);
    }
    const drizzleDb = drizzleMysql(pool, { schema, mode: 'default' });
    authRepo = new AuthRepository(drizzleDb as any, 'mysql');
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('preserves effective settings access exactly across the fan-out (the deliverable)', async () => {
    const check = realCheckPermissionAsyncFor(authRepo);
    const now = Date.now();

    async function makeUser(username: string, isAdmin = false): Promise<number> {
      const [result] = await pool.query(
        `INSERT INTO users (username, authMethod, isAdmin, createdAt, updatedAt) VALUES (?, 'local', ?, ?, ?)`,
        [username, isAdmin, now, now],
      );
      return (result as any).insertId;
    }
    async function makeSource(id: string): Promise<void> {
      await pool.query(
        `INSERT INTO sources (id, name, type, config, enabled, createdAt, updatedAt) VALUES (?, ?, 'meshtastic_tcp', '{}', 1, ?, ?)`,
        [id, id, now, now],
      );
    }
    async function grant(userId: number, resource: string, sourceId: string | null, canRead: boolean, canWrite: boolean): Promise<void> {
      await pool.query(
        `INSERT INTO permissions (userId, resource, sourceId, canRead, canWrite) VALUES (?, ?, ?, ?, ?)`,
        [userId, resource, sourceId, canRead, canWrite],
      );
    }

    const sA = `my-src-a-${now}`, sB = `my-src-b-${now}`, sC = `my-src-c-${now}`;
    await makeSource(sA); await makeSource(sB); await makeSource(sC);

    const u1 = await makeUser(`my_u1_${now}`);
    const u2 = await makeUser(`my_u2_${now}`);
    const u3 = await makeUser(`my_u3_${now}`);
    const u4 = await makeUser(`my_u4_${now}`);
    const u5 = await makeUser(`my_u5_${now}`);
    const u6 = await makeUser(`my_u6_${now}`);
    const u7 = await makeUser(`my_u7_${now}`, true);
    const u8 = await makeUser(`my_u8_anon_${now}`);

    const isAdminByUser = new Map<number, boolean>([[u1, false], [u2, false], [u3, false], [u4, false], [u5, false], [u6, false], [u7, true], [u8, false]]);
    const rawRows: RawRow[] = [];

    await grant(u1, 'settings', null, true, true);
    rawRows.push({ userId: u1, resource: 'settings', sourceId: null, canViewOnMap: false, canRead: true, canWrite: true });

    await grant(u2, 'settings', null, true, false);
    rawRows.push({ userId: u2, resource: 'settings', sourceId: null, canViewOnMap: false, canRead: true, canWrite: false });

    await grant(u3, 'settings', null, false, false);
    rawRows.push({ userId: u3, resource: 'settings', sourceId: null, canViewOnMap: false, canRead: false, canWrite: false });

    await grant(u5, 'settings', null, true, false);
    rawRows.push({ userId: u5, resource: 'settings', sourceId: null, canViewOnMap: false, canRead: true, canWrite: false });
    await grant(u5, 'settings', sA, false, true);
    rawRows.push({ userId: u5, resource: 'settings', sourceId: sA, canViewOnMap: false, canRead: false, canWrite: true });

    await grant(u6, 'settings', sA, false, true);
    rawRows.push({ userId: u6, resource: 'settings', sourceId: sA, canViewOnMap: false, canRead: false, canWrite: true });

    await grant(u7, 'settings', null, true, true);
    rawRows.push({ userId: u7, resource: 'settings', sourceId: null, canViewOnMap: false, canRead: true, canWrite: true });

    await grant(u1, 'nodes', sA, true, false);
    await grant(u2, 'themes', null, true, true);
    const [nonSettingsBefore] = await pool.query(`SELECT * FROM permissions WHERE resource != 'settings' ORDER BY id`);

    const users = { u1, u2, u3, u4, u5, u6, u7, u8 };
    const scopes: Array<string | undefined> = [sA, sB, sC, undefined];
    const actions: Array<'read' | 'write'> = ['read', 'write'];

    const before: Record<string, boolean> = {};
    for (const [label, userId] of Object.entries(users)) {
      const userRows = rawRows.filter((r) => r.userId === userId);
      for (const action of actions) for (const scope of scopes) {
        before[`${label}:${action}:${scope ?? 'undefined'}`] = frozenPreFlipCheck(isAdminByUser.get(userId)!, userRows, action);
      }
    }

    await runMigration132Mysql(pool);

    const after: Record<string, boolean> = {};
    for (const [label, userId] of Object.entries(users)) {
      for (const action of actions) for (const scope of scopes) {
        after[`${label}:${action}:${scope ?? 'undefined'}`] = await check(userId, 'settings', action, scope);
      }
    }

    expect(after).toEqual(before);

    expect(after['u1:read:undefined']).toBe(true);
    expect(after['u1:write:undefined']).toBe(true);
    expect(after['u2:read:undefined']).toBe(true);
    expect(after['u2:write:undefined']).toBe(false);
    expect(after['u5:read:undefined']).toBe(true);
    expect(after['u5:write:undefined']).toBe(true);
    expect(after['u6:read:undefined']).toBe(false);
    expect(after['u6:write:undefined']).toBe(true);

    const [nullRows] = await pool.query(`SELECT COUNT(*) AS c FROM permissions WHERE resource = 'settings' AND sourceId IS NULL`);
    expect((nullRows as any[])[0].c).toBe(0);

    const [settingsAfter] = await pool.query(`SELECT * FROM permissions WHERE resource = 'settings'`);
    expect((settingsAfter as any[]).length).toBe(5 * 3);

    const [nonSettingsAfter] = await pool.query(`SELECT * FROM permissions WHERE resource != 'settings' ORDER BY id`);
    expect(nonSettingsAfter).toEqual(nonSettingsBefore);

    const [allBefore] = await pool.query(`SELECT * FROM permissions ORDER BY id`);
    await runMigration132Mysql(pool);
    const [allAfter] = await pool.query(`SELECT * FROM permissions ORDER BY id`);
    expect(allAfter).toEqual(allBefore);
  });
});
