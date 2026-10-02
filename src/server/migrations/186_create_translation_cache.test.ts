/**
 * Migration 186 tests — translation_cache + message_translations (#5520).
 */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { migration, runMigration186Postgres, runMigration186Mysql } from './186_create_translation_cache.js';

describe('Migration 186 — translation cache tables', () => {
  describe('SQLite', () => {
    it('creates both tables and indexes, and is idempotent', () => {
      const db = new Database(':memory:');
      migration.up(db);
      expect(() => migration.up(db)).not.toThrow();

      const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','index')`).all() as Array<{ name: string }>)
        .map((r) => r.name);
      expect(names).toEqual(expect.arrayContaining([
        'translation_cache', 'message_translations', 'trc_prune_idx', 'msgtr_cache_key_idx',
      ]));
      db.close();
    });

    it('defaults counters to 0 and enforces the (sourceId, messageId, targetLang) PK', () => {
      const db = new Database(':memory:');
      migration.up(db);
      db.prepare(`INSERT INTO translation_cache (cacheKey, targetLang, translatedText, provider, createdAt, lastUsedAt)
        VALUES ('k1', 'en', 'Hello', 'deepl', 1, 1)`).run();
      const row = db.prepare(`SELECT hitCount, messageRefCount, sourceLang, pinnedAt FROM translation_cache`).get() as any;
      expect(row).toEqual({ hitCount: 0, messageRefCount: 0, sourceLang: null, pinnedAt: null });

      const insert = db.prepare(`INSERT INTO message_translations (sourceId, messageId, targetLang, cacheKey, createdAt)
        VALUES (?, ?, ?, 'k1', 1)`);
      insert.run('src-a', 'm1', 'en');
      insert.run('src-a', 'm1', 'es');
      insert.run('src-b', 'm1', 'en');
      expect(() => insert.run('src-a', 'm1', 'en')).toThrow();
      db.close();
    });

    it('has no text column — only the hash is stored', () => {
      const db = new Database(':memory:');
      migration.up(db);
      const cols = (db.prepare(`PRAGMA table_info(translation_cache)`).all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols).not.toContain('text');
      expect(cols).not.toContain('sourceText');
      db.close();
    });
  });

  describe('PostgreSQL', () => {
    it('creates both tables with quoted camelCase columns and indexes', async () => {
      const client = { query: vi.fn().mockResolvedValue(undefined) };
      await runMigration186Postgres(client as any);
      const sql = client.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS translation_cache/);
      expect(sql).toMatch(/"cacheKey" TEXT PRIMARY KEY/);
      expect(sql).toMatch(/"lastUsedAt" BIGINT NOT NULL/);
      expect(sql).toMatch(/"pinnedAt" BIGINT/);
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS message_translations/);
      expect(sql).toMatch(/PRIMARY KEY \("sourceId", "messageId", "targetLang"\)/);
      expect(sql).toMatch(/trc_prune_idx/);
      expect(sql).toMatch(/msgtr_cache_key_idx/);
    });
  });

  describe('MySQL', () => {
    function makeConn(existRows: any[]) {
      return { query: vi.fn().mockResolvedValue([existRows, []]), release: vi.fn() };
    }

    it('creates both tables when missing', async () => {
      const conn = makeConn([]);
      await runMigration186Mysql({ getConnection: vi.fn().mockResolvedValue(conn) } as any);
      const ddl = conn.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(ddl).toMatch(/CREATE TABLE translation_cache/);
      expect(ddl).toMatch(/cacheKey VARCHAR\(64\) PRIMARY KEY/);
      expect(ddl).toMatch(/pinnedAt BIGINT/);
      expect(ddl).toMatch(/CREATE TABLE message_translations/);
      expect(ddl).toMatch(/messageId VARCHAR\(64\) NOT NULL/);
      expect(ddl).toMatch(/PRIMARY KEY \(sourceId, messageId, targetLang\)/);
    });

    it('skips create when the tables already exist', async () => {
      const conn = makeConn([{ TABLE_NAME: 'x' }]);
      await runMigration186Mysql({ getConnection: vi.fn().mockResolvedValue(conn) } as any);
      const ddl = conn.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(ddl).not.toMatch(/CREATE TABLE/);
    });
  });
});
