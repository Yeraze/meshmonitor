/**
 * Migration 050 — PostgreSQL / MySQL behaviour (#4419 / PER_SOURCE_NODE_DISPLAY_PHASE5_SPEC §4.7).
 *
 * This is migration 050's FIRST PostgreSQL or MySQL coverage of any kind, despite it
 * shipping hand-written implementations for both backends since it was authored. Two
 * halves, per CLAUDE.md guidance for schema/migration work:
 *
 *   1. Fake-client half (always runs): pins the exact dialect SQL shape (quoted
 *      camelCase columns + `ON CONFLICT (key) DO NOTHING` on PostgreSQL, backticked
 *      `key` + `INSERT IGNORE` on MySQL) and the frozen-list behaviour — a global row
 *      whose key is not in `PROMOTED_SETTING_KEYS` is never promoted. Modeled on
 *      131_seed_per_source_node_display.pgmysql.test.ts.
 *
 *      Deliberately NO assertions on round-trip counts. 050's PG/MySQL loops issue one
 *      SELECT + one INSERT per key (~170 round trips) — the #4233 anti-pattern — but
 *      fixing that is explicitly out of scope for this freeze (spec §4.4): the ledger
 *      means this migration runs once per database, and pinning the round-trip count
 *      here would make a future batching fix fail this suite for no behavioural reason.
 *
 *   2. Container half (`describe.skipIf(!postgresAvailable/!mysqlAvailable)`): runs the
 *      real migration functions against the live test containers (localhost:5433 /
 *      :3307) and asserts the same promote/preserve/override/idempotency/backfill
 *      invariants as the SQLite suite. A silent skip here still reports `success: true`
 *      at the suite level — confirm via `numPendingTests` in the JSON reporter, not
 *      just the pass/fail summary.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import {
  runMigration050Postgres,
  runMigration050Mysql,
  PROMOTED_SETTING_KEYS,
} from './050_promote_globals_to_default_source.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

const SAMPLE_KEY = 'autoResponderEnabled'; // present in PROMOTED_SETTING_KEYS
const NOT_PROMOTED_KEY = 'someFutureSettingNotYetFrozen'; // deliberately NOT in the frozen list
const DEFAULT_SOURCE = { id: 'src-old', createdAt: 1000 };

// ---------------------------------------------------------------------------
// Fake-client half
// ---------------------------------------------------------------------------

function fakePgClient(opts: { globals: Record<string, string> }) {
  const queries: { sql: string; params?: any[] }[] = [];
  return {
    queries,
    query: vi.fn(async (sql: string, params?: any[]) => {
      queries.push({ sql, params });
      const s = sql.trimStart();
      if (s.startsWith("SELECT to_regclass")) {
        return { rows: [{ reg: 'sources' }] };
      }
      if (s.startsWith('SELECT id FROM sources')) {
        return { rows: [{ id: DEFAULT_SOURCE.id }] };
      }
      if (s.startsWith('SELECT value FROM settings')) {
        const key = params?.[0];
        const value = key !== undefined ? opts.globals[key] : undefined;
        return value === undefined ? { rows: [], rowCount: 0 } : { rows: [{ value }], rowCount: 1 };
      }
      if (s.startsWith('INSERT INTO settings')) {
        return { rows: [], rowCount: 1 };
      }
      if (s.startsWith('UPDATE auto_traceroute_nodes') || s.startsWith('UPDATE auto_time_sync_nodes')) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
}

function fakeMysqlPool(opts: { globals: Record<string, string> }) {
  const queries: { sql: string; params?: any[] }[] = [];
  const conn = {
    query: vi.fn(async (sql: string, params?: any[]) => {
      queries.push({ sql, params });
      const s = sql.trimStart();
      if (s.includes('information_schema.tables')) {
        return [[{ c: 1 }]];
      }
      if (s.startsWith('SELECT id FROM sources')) {
        return [[{ id: DEFAULT_SOURCE.id }]];
      }
      if (s.startsWith('SELECT value FROM settings')) {
        const key = params?.[0];
        const value = key !== undefined ? opts.globals[key] : undefined;
        return [value === undefined ? [] : [{ value }]];
      }
      if (s.startsWith('INSERT IGNORE INTO settings')) {
        return [{ affectedRows: 1 }];
      }
      if (s.startsWith('UPDATE auto_traceroute_nodes') || s.startsWith('UPDATE auto_time_sync_nodes')) {
        return [{ affectedRows: 0 }];
      }
      return [{}];
    }),
    beginTransaction: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}),
    release: vi.fn(),
  };
  return { queries, conn, getConnection: async () => conn };
}

const isInsert = (q: { sql: string }) => q.sql.trimStart().startsWith('INSERT');
const insertedKeyFrom = (params: any[] | undefined) => {
  const prefixedKey = params?.[0] as string | undefined;
  return prefixedKey?.replace(/^source:[^:]+:/, '');
};

describe('migration 050 — PostgreSQL (fake client)', () => {
  it('promotes a global row for a key in PROMOTED_SETTING_KEYS into source:{default}:{key}', async () => {
    const client = fakePgClient({ globals: { [SAMPLE_KEY]: 'true' } });
    await runMigration050Postgres(client as any);

    const inserts = client.queries.filter(isInsert);
    const match = inserts.find((ins) => insertedKeyFrom(ins.params) === SAMPLE_KEY);
    expect(match).toBeDefined();
    expect(match!.params?.[0]).toBe(`source:${DEFAULT_SOURCE.id}:${SAMPLE_KEY}`);
    expect(match!.params?.[1]).toBe('true');
  });

  it('quotes camelCase timestamp columns and uses ON CONFLICT (key) DO NOTHING', async () => {
    const client = fakePgClient({ globals: { [SAMPLE_KEY]: 'true' } });
    await runMigration050Postgres(client as any);

    const inserts = client.queries.filter(isInsert);
    expect(inserts.length).toBeGreaterThan(0);
    for (const ins of inserts) {
      expect(ins.sql).toContain('"createdAt"');
      expect(ins.sql).toContain('"updatedAt"');
      expect(ins.sql).toContain('ON CONFLICT (key) DO NOTHING');
    }
  });

  it('never promotes a global row whose key is not in PROMOTED_SETTING_KEYS (the freeze)', async () => {
    expect(PROMOTED_SETTING_KEYS).not.toContain(NOT_PROMOTED_KEY);
    const client = fakePgClient({ globals: { [SAMPLE_KEY]: 'true', [NOT_PROMOTED_KEY]: 'sneaky' } });
    await runMigration050Postgres(client as any);

    const inserts = client.queries.filter(isInsert);
    expect(inserts.some((ins) => insertedKeyFrom(ins.params) === NOT_PROMOTED_KEY)).toBe(false);
    // Sanity: the loop never even queries a key outside the frozen list.
    expect(client.queries.some((q) => q.sql.startsWith('SELECT value FROM settings') && q.params?.[0] === NOT_PROMOTED_KEY)).toBe(false);
  });

  it('when sources table is missing, logs and returns without throwing', async () => {
    const client = {
      queries: [] as any[],
      query: vi.fn(async (sql: string) => {
        if (sql.trimStart().startsWith('SELECT to_regclass')) {
          return { rows: [{ reg: null }] };
        }
        throw new Error('relation "sources" does not exist');
      }),
    };
    await expect(runMigration050Postgres(client as any)).resolves.toBeUndefined();
  });
});

describe('migration 050 — MySQL (fake pool)', () => {
  it('promotes a global row for a key in PROMOTED_SETTING_KEYS into source:{default}:{key}', async () => {
    const pool = fakeMysqlPool({ globals: { [SAMPLE_KEY]: 'true' } });
    await runMigration050Mysql(pool as any);

    const inserts = pool.queries.filter(isInsert);
    const match = inserts.find((ins) => insertedKeyFrom(ins.params) === SAMPLE_KEY);
    expect(match).toBeDefined();
    expect(match!.params?.[0]).toBe(`source:${DEFAULT_SOURCE.id}:${SAMPLE_KEY}`);
    expect(match!.params?.[1]).toBe('true');
    expect(pool.conn.commit).toHaveBeenCalled();
  });

  it('backticks `key` and uses INSERT IGNORE', async () => {
    const pool = fakeMysqlPool({ globals: { [SAMPLE_KEY]: 'true' } });
    await runMigration050Mysql(pool as any);

    const inserts = pool.queries.filter(isInsert);
    expect(inserts.length).toBeGreaterThan(0);
    for (const ins of inserts) {
      expect(ins.sql).toContain('`key`');
      expect(ins.sql).toContain('INSERT IGNORE');
    }
  });

  it('never promotes a global row whose key is not in PROMOTED_SETTING_KEYS (the freeze)', async () => {
    expect(PROMOTED_SETTING_KEYS).not.toContain(NOT_PROMOTED_KEY);
    const pool = fakeMysqlPool({ globals: { [SAMPLE_KEY]: 'true', [NOT_PROMOTED_KEY]: 'sneaky' } });
    await runMigration050Mysql(pool as any);

    const inserts = pool.queries.filter(isInsert);
    expect(inserts.some((ins) => insertedKeyFrom(ins.params) === NOT_PROMOTED_KEY)).toBe(false);
    expect(pool.queries.some((q) => q.sql.startsWith('SELECT value FROM settings') && q.params?.[0] === NOT_PROMOTED_KEY)).toBe(false);
  });

  it('when sources table is missing, logs and returns without throwing', async () => {
    const conn = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('information_schema.tables')) {
          return [[{ c: 0 }]];
        }
        throw new Error("Table 'meshmonitor.sources' doesn't exist");
      }),
      beginTransaction: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}),
      release: vi.fn(),
    };
    const pool = { getConnection: async () => conn };
    await expect(runMigration050Mysql(pool as any)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Container half — real PostgreSQL / MySQL test containers.
// ---------------------------------------------------------------------------

const PG_CREATE = `
  DROP TABLE IF EXISTS auto_traceroute_nodes CASCADE;
  DROP TABLE IF EXISTS auto_time_sync_nodes CASCADE;
  DROP TABLE IF EXISTS settings CASCADE;
  DROP TABLE IF EXISTS sources CASCADE;
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
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL
  );
  CREATE TABLE auto_traceroute_nodes (
    id SERIAL PRIMARY KEY,
    "nodeNum" BIGINT NOT NULL,
    enabled BOOLEAN DEFAULT true,
    "createdAt" BIGINT NOT NULL,
    "sourceId" TEXT
  );
  CREATE TABLE auto_time_sync_nodes (
    id SERIAL PRIMARY KEY,
    "nodeNum" BIGINT NOT NULL,
    enabled BOOLEAN DEFAULT true,
    "createdAt" BIGINT NOT NULL,
    "sourceId" TEXT
  );
`;

const MYSQL_CREATE = `
  DROP TABLE IF EXISTS auto_traceroute_nodes;
  DROP TABLE IF EXISTS auto_time_sync_nodes;
  DROP TABLE IF EXISTS settings;
  DROP TABLE IF EXISTS sources;
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
  CREATE TABLE settings (
    \`key\` VARCHAR(255) PRIMARY KEY,
    value TEXT NOT NULL,
    createdAt BIGINT NOT NULL,
    updatedAt BIGINT NOT NULL
  );
  CREATE TABLE auto_traceroute_nodes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nodeNum BIGINT NOT NULL,
    enabled TINYINT DEFAULT 1,
    createdAt BIGINT NOT NULL,
    sourceId VARCHAR(64)
  );
  CREATE TABLE auto_time_sync_nodes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nodeNum BIGINT NOT NULL,
    enabled TINYINT DEFAULT 1,
    createdAt BIGINT NOT NULL,
    sourceId VARCHAR(64)
  );
`;

describe.skipIf(!postgresAvailable)('migration 050 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig50'));
    await pool.query(PG_CREATE);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('promotes globals, preserves the source, does not clobber overrides, backfills orphans, and is idempotent', async () => {
    const now = Date.now();
    await pool.query(
      `INSERT INTO sources (id, name, type, config, enabled, "createdAt", "updatedAt")
       VALUES ('src-old', 'Old', 'meshtastic_tcp', '{}', true, $1, $1),
              ('src-new', 'New', 'meshtastic_tcp', '{}', true, $2, $2)`,
      [now, now + 1000],
    );
    await pool.query(
      `INSERT INTO settings (key, value, "createdAt", "updatedAt") VALUES
        ('autoResponderEnabled', 'true', $1, $1),
        ('source:src-old:tracerouteIntervalMinutes', 'override-value', $1, $1),
        ('tracerouteIntervalMinutes', 'global-value', $1, $1)`,
      [now],
    );
    await pool.query(
      `INSERT INTO auto_traceroute_nodes ("nodeNum", "createdAt", "sourceId") VALUES ($1, $2, NULL)`,
      [0xdeadbeef, now],
    );
    await pool.query(
      `INSERT INTO auto_time_sync_nodes ("nodeNum", "createdAt", "sourceId") VALUES ($1, $2, NULL)`,
      [0xcafebabe, now],
    );

    const client1 = await pool.connect();
    try {
      await runMigration050Postgres(client1);
    } finally {
      client1.release();
    }

    const { rows } = await pool.query(`SELECT key, value FROM settings WHERE key LIKE 'source:%'`);
    const settings = Object.fromEntries(rows.map((r: any) => [r.key, r.value]));

    // The oldest source (src-old, earlier createdAt) is the default and receives the promotion.
    expect(settings['source:src-old:autoResponderEnabled']).toBe('true');
    // The newer source must NOT inherit.
    expect(settings['source:src-new:autoResponderEnabled']).toBeUndefined();
    // Existing per-source override is untouched.
    expect(settings['source:src-old:tracerouteIntervalMinutes']).toBe('override-value');

    // Original global row is preserved (non-destructive).
    const { rows: globalRow } = await pool.query(`SELECT value FROM settings WHERE key = 'autoResponderEnabled'`);
    expect(globalRow[0].value).toBe('true');

    // Backfills.
    const { rows: trRows } = await pool.query(`SELECT "sourceId" FROM auto_traceroute_nodes`);
    expect(trRows[0].sourceId).toBe('src-old');
    const { rows: tsRows } = await pool.query(`SELECT "sourceId" FROM auto_time_sync_nodes`);
    expect(tsRows[0].sourceId).toBe('src-old');

    const { rows: countBefore } = await pool.query(`SELECT COUNT(*)::int AS c FROM settings`);

    // Idempotency: run again.
    const client2 = await pool.connect();
    try {
      await runMigration050Postgres(client2);
    } finally {
      client2.release();
    }

    const { rows: countAfter } = await pool.query(`SELECT COUNT(*)::int AS c FROM settings`);
    expect(countAfter[0].c).toBe(countBefore[0].c);

    const { rows: overrideAfter } = await pool.query(
      `SELECT value FROM settings WHERE key = 'source:src-old:tracerouteIntervalMinutes'`,
    );
    expect(overrideAfter[0].value).toBe('override-value');
  });
});

describe.skipIf(!mysqlAvailable)('migration 050 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig50'));
    // MySQL2's pool.query doesn't run multi-statement by default; execute
    // the DDL statements individually.
    for (const stmt of MYSQL_CREATE.split(';').map((s) => s.trim()).filter(Boolean)) {
      await pool.query(stmt);
    }
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('promotes globals, preserves the source, does not clobber overrides, backfills orphans, and is idempotent', async () => {
    const now = Date.now();
    await pool.query(
      `INSERT INTO sources (id, name, type, config, enabled, createdAt, updatedAt)
       VALUES ('src-old', 'Old', 'meshtastic_tcp', '{}', 1, ?, ?),
              ('src-new', 'New', 'meshtastic_tcp', '{}', 1, ?, ?)`,
      [now, now, now + 1000, now + 1000],
    );
    await pool.query(
      'INSERT INTO settings (`key`, value, createdAt, updatedAt) VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)',
      [
        'autoResponderEnabled', 'true', now, now,
        'source:src-old:tracerouteIntervalMinutes', 'override-value', now, now,
        'tracerouteIntervalMinutes', 'global-value', now, now,
      ],
    );
    await pool.query(
      `INSERT INTO auto_traceroute_nodes (nodeNum, createdAt, sourceId) VALUES (?, ?, NULL)`,
      [0xdeadbeef, now],
    );
    await pool.query(
      `INSERT INTO auto_time_sync_nodes (nodeNum, createdAt, sourceId) VALUES (?, ?, NULL)`,
      [0xcafebabe, now],
    );

    await runMigration050Mysql(pool);

    const [rows] = await pool.query(`SELECT \`key\`, value FROM settings WHERE \`key\` LIKE 'source:%'`);
    const settings: Record<string, string> = {};
    for (const row of rows as any[]) settings[row.key] = row.value;

    expect(settings['source:src-old:autoResponderEnabled']).toBe('true');
    expect(settings['source:src-new:autoResponderEnabled']).toBeUndefined();
    expect(settings['source:src-old:tracerouteIntervalMinutes']).toBe('override-value');

    const [globalRow] = await pool.query(`SELECT value FROM settings WHERE \`key\` = 'autoResponderEnabled'`);
    expect((globalRow as any[])[0].value).toBe('true');

    const [trRows] = await pool.query(`SELECT sourceId FROM auto_traceroute_nodes`);
    expect((trRows as any[])[0].sourceId).toBe('src-old');
    const [tsRows] = await pool.query(`SELECT sourceId FROM auto_time_sync_nodes`);
    expect((tsRows as any[])[0].sourceId).toBe('src-old');

    const [countBeforeRows] = await pool.query(`SELECT COUNT(*) AS c FROM settings`);
    const countBefore = (countBeforeRows as any[])[0].c;

    await runMigration050Mysql(pool);

    const [countAfterRows] = await pool.query(`SELECT COUNT(*) AS c FROM settings`);
    const countAfter = (countAfterRows as any[])[0].c;
    expect(countAfter).toBe(countBefore);

    const [overrideAfter] = await pool.query(
      "SELECT value FROM settings WHERE `key` = 'source:src-old:tracerouteIntervalMinutes'",
    );
    expect((overrideAfter as any[])[0].value).toBe('override-value');
  });
});
