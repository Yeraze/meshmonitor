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

const ENV_KEYS = ['MESHTASTIC_NODE_IP', 'MESHTASTIC_TCP_PORT'] as const;
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
    delete process.env.MESHTASTIC_NODE_IP;
    delete process.env.MESHTASTIC_TCP_PORT;
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
});
