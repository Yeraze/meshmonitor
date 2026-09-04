/**
 * Migration 131 — PostgreSQL / MySQL behaviour (#4412 Phase 1 WP4).
 *
 * Two halves, per CLAUDE.md guidance for schema/migration work:
 *
 *   1. Fake-client half (always runs): pins the #4233 batching guard — reads
 *      are single round trips, and inserts are batched rather than one
 *      round-trip per row — plus the exact dialect SQL shape (quoted
 *      camelCase columns + ON CONFLICT on PostgreSQL, backticked `key` +
 *      INSERT IGNORE on MySQL). Modeled on
 *      030_route_segments_rebuild.pgmysql.test.ts.
 *
 *   2. Container half (`describe.skipIf(!postgresAvailable/!mysqlAvailable)`):
 *      runs the real migration functions against the live test containers
 *      (localhost:5433 / :3307) and asserts the same seed/override/idempotency
 *      invariants as the SQLite test. A silent skip here still reports
 *      `success: true` at the suite level — confirm via `numPendingTests` in
 *      the JSON reporter, not just the pass/fail summary.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import {
  runMigration131Postgres,
  runMigration131Mysql,
  NODE_DISPLAY_SEED,
} from './131_seed_per_source_node_display.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';
const TEN_KEYS = NODE_DISPLAY_SEED.map(([key]) => key);
const KEY_COUNT = TEN_KEYS.length; // 10

function sourceRows(n: number): Array<{ id: string }> {
  return Array.from({ length: n }, (_, i) => ({ id: `src-${i}` }));
}

// ---------------------------------------------------------------------------
// Fake-client half
// ---------------------------------------------------------------------------

function fakePgClient(opts: { sources: Array<{ id: string }>; globals?: Array<{ key: string; value: string }> }) {
  const queries: { sql: string; params?: any[] }[] = [];
  return {
    queries,
    query: vi.fn(async (sql: string, params?: any[]) => {
      queries.push({ sql, params });
      const s = sql.trimStart();
      if (s.startsWith('SELECT id FROM sources')) {
        return { rows: opts.sources };
      }
      if (s.startsWith('SELECT key, value FROM settings')) {
        return { rows: opts.globals ?? [] };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
}

function fakeMysqlPool(opts: { sources: Array<{ id: string }>; globals?: Array<{ key: string; value: string }> }) {
  const queries: { sql: string; params?: any[] }[] = [];
  const conn = {
    query: vi.fn(async (sql: string, params?: any[]) => {
      queries.push({ sql, params });
      const s = sql.trimStart();
      if (s.startsWith('SELECT id FROM sources')) {
        return [opts.sources];
      }
      if (s.includes('FROM settings')) {
        return [opts.globals ?? []];
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

const isSelectSources = (q: { sql: string }) => q.sql.trimStart().startsWith('SELECT id FROM sources');
const isSelectSettings = (q: { sql: string }) => q.sql.trimStart().startsWith('SELECT') && q.sql.includes('FROM settings');
const isInsert = (q: { sql: string }) => q.sql.trimStart().startsWith('INSERT');

describe('migration 131 — PostgreSQL (fake client)', () => {
  it('reads sources and globals in exactly one round trip each', async () => {
    const client = fakePgClient({ sources: sourceRows(3) });
    await runMigration131Postgres(client as any);

    expect(client.queries.filter(isSelectSources)).toHaveLength(1);
    expect(client.queries.filter(isSelectSettings)).toHaveLength(1);
  });

  it('batches inserts instead of one round-trip per row', async () => {
    // 50 sources x 10 keys = 500 rows -> ceil(500 / 200) = 3 batches.
    const client = fakePgClient({ sources: sourceRows(50) });
    await runMigration131Postgres(client as any);

    const inserts = client.queries.filter(isInsert);
    expect(inserts).toHaveLength(3);
    expect(50 * KEY_COUNT).toBe(500);
  });

  it('quotes camelCase timestamp columns and uses ON CONFLICT DO NOTHING', async () => {
    const client = fakePgClient({ sources: sourceRows(1) });
    await runMigration131Postgres(client as any);

    const inserts = client.queries.filter(isInsert);
    expect(inserts.length).toBeGreaterThan(0);
    for (const ins of inserts) {
      expect(ins.sql).toContain('"createdAt"');
      expect(ins.sql).toContain('"updatedAt"');
      expect(ins.sql).toContain('ON CONFLICT (key) DO NOTHING');
    }
  });

  it('is a no-op with no sources: no BEGIN, no INSERT', async () => {
    const client = fakePgClient({ sources: [] });
    await runMigration131Postgres(client as any);

    expect(client.queries.filter(isInsert)).toHaveLength(0);
    expect(client.queries.some((q) => q.sql.includes('BEGIN'))).toBe(false);
  });

  it('when sources table is missing, logs and returns without throwing', async () => {
    const client = {
      queries: [] as any[],
      query: vi.fn(async () => {
        throw new Error('relation "sources" does not exist');
      }),
    };
    await expect(runMigration131Postgres(client as any)).resolves.toBeUndefined();
  });
});

describe('migration 131 — MySQL (fake pool)', () => {
  it('reads sources and globals in exactly one round trip each', async () => {
    const pool = fakeMysqlPool({ sources: sourceRows(3) });
    await runMigration131Mysql(pool as any);

    expect(pool.queries.filter(isSelectSources)).toHaveLength(1);
    expect(pool.queries.filter(isSelectSettings)).toHaveLength(1);
    expect(pool.conn.release).toHaveBeenCalled();
  });

  it('batches inserts instead of one round-trip per row', async () => {
    const pool = fakeMysqlPool({ sources: sourceRows(50) });
    await runMigration131Mysql(pool as any);

    const inserts = pool.queries.filter(isInsert);
    expect(inserts).toHaveLength(3);
    expect(pool.conn.commit).toHaveBeenCalled();
  });

  it('backticks `key` and uses INSERT IGNORE', async () => {
    const pool = fakeMysqlPool({ sources: sourceRows(1) });
    await runMigration131Mysql(pool as any);

    const inserts = pool.queries.filter(isInsert);
    expect(inserts.length).toBeGreaterThan(0);
    for (const ins of inserts) {
      expect(ins.sql).toContain('`key`');
      expect(ins.sql).toContain('INSERT IGNORE');
    }
  });

  it('is a no-op with no sources: no beginTransaction, no INSERT', async () => {
    const pool = fakeMysqlPool({ sources: [] });
    await runMigration131Mysql(pool as any);

    expect(pool.queries.filter(isInsert)).toHaveLength(0);
    expect(pool.conn.beginTransaction).not.toHaveBeenCalled();
    expect(pool.conn.release).toHaveBeenCalled();
  });

  it('when sources table is missing, logs and returns without throwing', async () => {
    const conn = {
      query: vi.fn(async () => {
        throw new Error("Table 'meshmonitor.sources' doesn't exist");
      }),
      beginTransaction: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}),
      release: vi.fn(),
    };
    const pool = { getConnection: async () => conn };
    await expect(runMigration131Mysql(pool as any)).resolves.toBeUndefined();
    expect(conn.release).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Container half — real PostgreSQL / MySQL test containers.
// ---------------------------------------------------------------------------

const PG_CREATE = `
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
`;

const MYSQL_CREATE = `
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
`;

describe.skipIf(!postgresAvailable)('migration 131 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig131'));
    await pool.query(PG_CREATE);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('seeds every source, propagates globals, preserves overrides, and is idempotent', async () => {
    const now = Date.now();
    await pool.query(
      `INSERT INTO sources (id, name, type, config, enabled, "createdAt", "updatedAt")
       VALUES ('override-src', 'Override', 'meshtastic_tcp', '{}', true, $1, $1),
              ('plain-src', 'Plain', 'meshtastic_tcp', '{}', true, $1, $1)`,
      [now],
    );
    await pool.query(
      `INSERT INTO settings (key, value, "createdAt", "updatedAt") VALUES
        ('source:override-src:maxNodeAgeHours', '99', $1, $1),
        ('maxNodeAgeHours', '72', $1, $1)`,
      [now],
    );

    const client1 = await pool.connect();
    try {
      await runMigration131Postgres(client1);
    } finally {
      client1.release();
    }

    const { rows } = await pool.query(`SELECT key, value FROM settings WHERE key LIKE 'source:%'`);
    const settings = Object.fromEntries(rows.map((r: any) => [r.key, r.value]));

    // Override untouched.
    expect(settings['source:override-src:maxNodeAgeHours']).toBe('99');
    // Global propagated.
    expect(settings['source:plain-src:maxNodeAgeHours']).toBe('72');
    // Every source got every key.
    for (const source of ['override-src', 'plain-src']) {
      for (const key of TEN_KEYS) {
        expect(settings[`source:${source}:${key}`]).toBeDefined();
      }
    }
    // Booleans use '0'.
    expect(settings['source:plain-src:hideIncompleteNodes']).toBe('0');

    const { rows: countBefore } = await pool.query(`SELECT COUNT(*)::int AS c FROM settings`);

    // Idempotency: run again.
    const client2 = await pool.connect();
    try {
      await runMigration131Postgres(client2);
    } finally {
      client2.release();
    }

    const { rows: countAfter } = await pool.query(`SELECT COUNT(*)::int AS c FROM settings`);
    expect(countAfter[0].c).toBe(countBefore[0].c);

    const { rows: after } = await pool.query(
      `SELECT value FROM settings WHERE key = 'source:override-src:maxNodeAgeHours'`,
    );
    expect(after[0].value).toBe('99');
  });
});

describe.skipIf(!mysqlAvailable)('migration 131 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig131'));
    // MySQL2's pool.query doesn't run multi-statement by default; execute
    // the DDL statements individually.
    for (const stmt of MYSQL_CREATE.split(';').map((s) => s.trim()).filter(Boolean)) {
      await pool.query(stmt);
    }
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('seeds every source, propagates globals, preserves overrides, and is idempotent', async () => {
    const now = Date.now();
    await pool.query(
      `INSERT INTO sources (id, name, type, config, enabled, createdAt, updatedAt)
       VALUES ('override-src', 'Override', 'meshtastic_tcp', '{}', 1, ?, ?),
              ('plain-src', 'Plain', 'meshtastic_tcp', '{}', 1, ?, ?)`,
      [now, now, now, now],
    );
    await pool.query(
      'INSERT INTO settings (`key`, value, createdAt, updatedAt) VALUES (?, ?, ?, ?), (?, ?, ?, ?)',
      ['source:override-src:maxNodeAgeHours', '99', now, now, 'maxNodeAgeHours', '72', now, now],
    );

    await runMigration131Mysql(pool);

    const [rows] = await pool.query(`SELECT \`key\`, value FROM settings WHERE \`key\` LIKE 'source:%'`);
    const settings: Record<string, string> = {};
    for (const row of rows as any[]) settings[row.key] = row.value;

    expect(settings['source:override-src:maxNodeAgeHours']).toBe('99');
    expect(settings['source:plain-src:maxNodeAgeHours']).toBe('72');
    for (const source of ['override-src', 'plain-src']) {
      for (const key of TEN_KEYS) {
        expect(settings[`source:${source}:${key}`]).toBeDefined();
      }
    }
    expect(settings['source:plain-src:hideIncompleteNodes']).toBe('0');

    const [countBeforeRows] = await pool.query(`SELECT COUNT(*) AS c FROM settings`);
    const countBefore = (countBeforeRows as any[])[0].c;

    await runMigration131Mysql(pool);

    const [countAfterRows] = await pool.query(`SELECT COUNT(*) AS c FROM settings`);
    const countAfter = (countAfterRows as any[])[0].c;
    expect(countAfter).toBe(countBefore);

    const [afterRows] = await pool.query(
      "SELECT value FROM settings WHERE `key` = 'source:override-src:maxNodeAgeHours'",
    );
    expect((afterRows as any[])[0].value).toBe('99');
  });
});
