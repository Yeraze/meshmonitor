/**
 * Regression tests for the legacy-default-source helper. The default-source
 * row is created `enabled=0` when `MESHTASTIC_NODE_IP` is unset or empty —
 * this keeps fresh MeshCore-only desktop installs from flapping forever
 * against a placeholder Meshtastic address (discussion #2604). When the user
 * explicitly sets the env var the row is created `enabled=1`, matching the
 * pre-fix Docker-flow behavior.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  buildLegacyDefaultSource,
  ensureDefaultSourceIdSqlite,
  ensureDefaultSourceIdPostgres,
  ensureDefaultSourceIdMysql,
} from './_legacyDefaultSource.js';

function createSourcesTable(db: Database.Database) {
  db.exec(`
    CREATE TABLE sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      config TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
  `);
}

const ENV_KEYS = [
  'MESHTASTIC_NODE_IP',
  'MESHTASTIC_TCP_PORT',
  'MESHTASTIC_NODE_PORT',
  'ENABLE_VIRTUAL_NODE',
  'VIRTUAL_NODE_PORT',
] as const;
type EnvSnapshot = Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

function snapshotEnv(): EnvSnapshot {
  const snap: EnvSnapshot = {};
  for (const key of ENV_KEYS) snap[key] = process.env[key];
  return snap;
}

function restoreEnv(snap: EnvSnapshot) {
  for (const key of ENV_KEYS) {
    const v = snap[key];
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  }
}

describe('_legacyDefaultSource', () => {
  let envSnap: EnvSnapshot;
  let db: Database.Database;

  beforeEach(() => {
    envSnap = snapshotEnv();
    for (const key of ENV_KEYS) delete process.env[key];
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
    restoreEnv(envSnap);
  });

  describe('buildLegacyDefaultSource', () => {
    it('enabled=0 + meshtastic.local fallback when MESHTASTIC_NODE_IP is unset', () => {
      const src = buildLegacyDefaultSource();
      expect(src.enabled).toBe(0);
      const cfg = JSON.parse(src.config);
      expect(cfg.host).toBe('meshtastic.local');
      expect(cfg.port).toBe(4403);
    });

    it('enabled=0 when MESHTASTIC_NODE_IP is an empty string', () => {
      process.env.MESHTASTIC_NODE_IP = '';
      const src = buildLegacyDefaultSource();
      expect(src.enabled).toBe(0);
      const cfg = JSON.parse(src.config);
      expect(cfg.host).toBe('meshtastic.local');
    });

    it('enabled=0 when MESHTASTIC_NODE_IP is whitespace-only', () => {
      process.env.MESHTASTIC_NODE_IP = '   ';
      const src = buildLegacyDefaultSource();
      expect(src.enabled).toBe(0);
      const cfg = JSON.parse(src.config);
      expect(cfg.host).toBe('meshtastic.local');
    });

    it('enabled=1 with the user value when MESHTASTIC_NODE_IP is set', () => {
      process.env.MESHTASTIC_NODE_IP = '10.0.0.42';
      process.env.MESHTASTIC_TCP_PORT = '4404';
      const src = buildLegacyDefaultSource();
      expect(src.enabled).toBe(1);
      const cfg = JSON.parse(src.config);
      expect(cfg.host).toBe('10.0.0.42');
      expect(cfg.port).toBe(4404);
    });
  });

  describe('ensureDefaultSourceIdSqlite', () => {
    it('returns null when the sources table does not exist', () => {
      const id = ensureDefaultSourceIdSqlite(db, 'test');
      expect(id).toBeNull();
    });

    it('seeds a disabled row when MESHTASTIC_NODE_IP is unset', () => {
      createSourcesTable(db);
      const id = ensureDefaultSourceIdSqlite(db, 'test');
      expect(id).toBeTypeOf('string');
      const row = db
        .prepare(`SELECT enabled, config FROM sources WHERE id = ?`)
        .get(id) as { enabled: number; config: string };
      expect(row.enabled).toBe(0);
      expect(JSON.parse(row.config).host).toBe('meshtastic.local');
    });

    it('seeds an enabled row when MESHTASTIC_NODE_IP is set', () => {
      process.env.MESHTASTIC_NODE_IP = '10.0.0.42';
      createSourcesTable(db);
      const id = ensureDefaultSourceIdSqlite(db, 'test');
      const row = db
        .prepare(`SELECT enabled, config FROM sources WHERE id = ?`)
        .get(id) as { enabled: number; config: string };
      expect(row.enabled).toBe(1);
      expect(JSON.parse(row.config).host).toBe('10.0.0.42');
    });

    it('returns the existing source id if any row is already present (idempotent)', () => {
      createSourcesTable(db);
      db.prepare(
        `INSERT INTO sources (id, name, type, config, enabled, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('preexisting', 'Existing', 'meshtastic_tcp', '{}', 1, 1, 1);
      const id = ensureDefaultSourceIdSqlite(db, 'test');
      expect(id).toBe('preexisting');
      // No second row was inserted.
      const count = (
        db.prepare(`SELECT COUNT(*) AS c FROM sources`).get() as { c: number }
      ).c;
      expect(count).toBe(1);
    });
  });

  describe('first-boot Virtual Node env vars (#5874)', () => {
    const VN = { enabled: true, port: 4499, allowAdminCommands: false };

    it('adds virtualNode with admin commands off when ENABLE_VIRTUAL_NODE and MESHTASTIC_NODE_IP are set', () => {
      process.env.MESHTASTIC_NODE_IP = '10.0.0.42';
      process.env.ENABLE_VIRTUAL_NODE = 'true';
      process.env.VIRTUAL_NODE_PORT = '4499';
      const cfg = JSON.parse(buildLegacyDefaultSource().config);
      expect(cfg.virtualNode).toEqual(VN);
    });

    it('uses port 4404 when VIRTUAL_NODE_PORT is unset', () => {
      process.env.MESHTASTIC_NODE_IP = '10.0.0.42';
      process.env.ENABLE_VIRTUAL_NODE = 'yes';
      const cfg = JSON.parse(buildLegacyDefaultSource().config);
      expect(cfg.virtualNode.port).toBe(4404);
    });

    it('adds no virtualNode when MESHTASTIC_NODE_IP is unset (source is disabled)', () => {
      process.env.ENABLE_VIRTUAL_NODE = 'true';
      const src = buildLegacyDefaultSource();
      expect(src.enabled).toBe(0);
      expect(JSON.parse(src.config).virtualNode).toBeUndefined();
    });

    it('adds no virtualNode for VIRTUAL_NODE_PORT alone', () => {
      process.env.MESHTASTIC_NODE_IP = '10.0.0.42';
      process.env.VIRTUAL_NODE_PORT = '4499';
      expect(JSON.parse(buildLegacyDefaultSource().config).virtualNode).toBeUndefined();
    });

    it('adds no virtualNode for an out-of-range port', () => {
      process.env.MESHTASTIC_NODE_IP = '10.0.0.42';
      process.env.ENABLE_VIRTUAL_NODE = 'true';
      process.env.VIRTUAL_NODE_PORT = '70000';
      expect(JSON.parse(buildLegacyDefaultSource().config).virtualNode).toBeUndefined();
    });

    it('honours MESHTASTIC_NODE_PORT like environment.ts does', () => {
      process.env.MESHTASTIC_NODE_IP = '10.0.0.42';
      process.env.MESHTASTIC_NODE_PORT = '4410';
      process.env.MESHTASTIC_TCP_PORT = '4403';
      expect(JSON.parse(buildLegacyDefaultSource().config).port).toBe(4410);
    });

    it('SQLite: a second run with different env leaves the existing row alone', () => {
      process.env.MESHTASTIC_NODE_IP = '10.0.0.42';
      process.env.ENABLE_VIRTUAL_NODE = 'true';
      process.env.VIRTUAL_NODE_PORT = '4499';
      createSourcesTable(db);
      const id = ensureDefaultSourceIdSqlite(db, 'test');
      process.env.VIRTUAL_NODE_PORT = '5555';
      process.env.ENABLE_VIRTUAL_NODE = 'false';
      expect(ensureDefaultSourceIdSqlite(db, 'test')).toBe(id);
      const rows = db.prepare(`SELECT config FROM sources`).all() as { config: string }[];
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0].config).virtualNode).toEqual(VN);
    });

    it('PostgreSQL path writes the same virtualNode block', async () => {
      process.env.MESHTASTIC_NODE_IP = '10.0.0.42';
      process.env.ENABLE_VIRTUAL_NODE = 'true';
      process.env.VIRTUAL_NODE_PORT = '4499';
      const calls: { sql: string; params?: unknown[] }[] = [];
      const client = {
        query: async (sql: string, params?: unknown[]) => {
          calls.push({ sql, params });
          if (sql.includes('to_regclass')) return { rows: [{ reg: 'sources' }] };
          return { rows: [] };
        },
      };
      await ensureDefaultSourceIdPostgres(client, 'test');
      const insert = calls.find((c) => c.sql.includes('INSERT INTO sources'))!;
      expect(JSON.parse(insert.params![3] as string).virtualNode).toEqual(VN);
      expect(insert.params![4]).toBe(true);
    });

    it('MySQL path writes the same virtualNode block', async () => {
      process.env.MESHTASTIC_NODE_IP = '10.0.0.42';
      process.env.ENABLE_VIRTUAL_NODE = 'true';
      process.env.VIRTUAL_NODE_PORT = '4499';
      const calls: { sql: string; params?: unknown[] }[] = [];
      const conn = {
        query: async (sql: string, params?: unknown[]) => {
          calls.push({ sql, params });
          if (sql.includes('information_schema.tables')) return [[{ c: 1 }]];
          return [[]];
        },
        release: () => {},
      };
      await ensureDefaultSourceIdMysql({ getConnection: async () => conn }, 'test');
      const insert = calls.find((c) => c.sql.includes('INSERT INTO sources'))!;
      expect(JSON.parse(insert.params![3] as string).virtualNode).toEqual(VN);
      expect(insert.params![4]).toBe(1);
    });
  });
});
