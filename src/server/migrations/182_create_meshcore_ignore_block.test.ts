/**
 * Migration 182 tests — meshcore_ignored_nodes + meshcore_message_filters (#5408).
 */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { migration, runMigration182Postgres, runMigration182Mysql } from './182_create_meshcore_ignore_block.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE sources (id TEXT PRIMARY KEY)`);
  db.exec(`INSERT INTO sources (id) VALUES ('src-a'), ('src-b')`);
  return db;
}

const KEY = 'ab'.repeat(32);

describe('Migration 182 — MeshCore ignore/block tables', () => {
  describe('SQLite', () => {
    it('creates both tables with every column and is idempotent', () => {
      const db = freshDb();
      migration.up(db);
      expect(() => migration.up(db)).not.toThrow();
      const cols = (t: string) =>
        (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols('meshcore_ignored_nodes')).toEqual(expect.arrayContaining([
        'sourceId', 'publicKey', 'name', 'mode', 'createdAt', 'createdBy', 'hitCount', 'lastHitAt',
      ]));
      expect(cols('meshcore_message_filters')).toEqual(expect.arrayContaining([
        'id', 'sourceId', 'mode', 'matchType', 'pattern', 'caseSensitive', 'fields', 'enabled',
        'createdAt', 'createdBy', 'hitCount', 'lastHitAt',
      ]));
      db.close();
    });

    it('applies defaults and enforces the (sourceId, publicKey) PK', () => {
      const db = freshDb();
      migration.up(db);
      const insert = db.prepare(`INSERT INTO meshcore_ignored_nodes (sourceId, publicKey, createdAt) VALUES (?, ?, ?)`);
      insert.run('src-a', KEY, 1);
      insert.run('src-b', KEY, 1);
      expect(() => insert.run('src-a', KEY, 2)).toThrow();
      const row = db.prepare(`SELECT * FROM meshcore_ignored_nodes WHERE sourceId = 'src-a'`).get() as any;
      expect(row.mode).toBe('ignore');
      expect(row.hitCount).toBe(0);
      db.prepare(`INSERT INTO meshcore_message_filters (id, sourceId, matchType, pattern, createdAt) VALUES ('r1', 'src-a', 'exact', 'x', 1)`).run();
      const rule = db.prepare(`SELECT * FROM meshcore_message_filters WHERE id = 'r1'`).get() as any;
      expect(rule).toMatchObject({ mode: 'ignore', fields: 'both', caseSensitive: 0, enabled: 1, hitCount: 0 });
      db.close();
    });

    it('cascades a source delete to both tables', () => {
      const db = freshDb();
      migration.up(db);
      db.prepare(`INSERT INTO meshcore_ignored_nodes (sourceId, publicKey, createdAt) VALUES ('src-a', ?, 1)`).run(KEY);
      db.prepare(`INSERT INTO meshcore_message_filters (id, sourceId, matchType, pattern, createdAt) VALUES ('r1', 'src-a', 'exact', 'x', 1)`).run();
      db.prepare(`DELETE FROM sources WHERE id = 'src-a'`).run();
      expect((db.prepare(`SELECT COUNT(*) AS c FROM meshcore_ignored_nodes`).get() as { c: number }).c).toBe(0);
      expect((db.prepare(`SELECT COUNT(*) AS c FROM meshcore_message_filters`).get() as { c: number }).c).toBe(0);
      db.close();
    });
  });

  describe('PostgreSQL (DDL shape)', () => {
    it('creates both tables with BIGINT timestamps and cascading FKs', async () => {
      const client = { query: vi.fn().mockResolvedValue(undefined) };
      await runMigration182Postgres(client as any);
      const sql = client.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS meshcore_ignored_nodes/);
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS meshcore_message_filters/);
      expect(sql).toMatch(/"createdAt" BIGINT NOT NULL/);
      expect(sql).toMatch(/PRIMARY KEY \("sourceId", "publicKey"\)/);
      expect(sql.match(/REFERENCES sources\(id\) ON DELETE CASCADE/g)).toHaveLength(2);
    });
  });

  describe('MySQL (DDL shape)', () => {
    function makeConn(existRows: any[]) {
      return { query: vi.fn().mockResolvedValue([existRows, []]), release: vi.fn() };
    }

    it('creates both tables when missing', async () => {
      const conn = makeConn([]);
      await runMigration182Mysql({ getConnection: vi.fn().mockResolvedValue(conn) } as any);
      const ddl = conn.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(ddl).toMatch(/CREATE TABLE meshcore_ignored_nodes/);
      expect(ddl).toMatch(/CREATE TABLE meshcore_message_filters/);
      expect(ddl).toMatch(/publicKey VARCHAR\(64\) NOT NULL/);
      expect(ddl.match(/FOREIGN KEY \(sourceId\) REFERENCES sources\(id\) ON DELETE CASCADE/g)).toHaveLength(2);
    });

    it('skips create when the tables exist', async () => {
      const conn = makeConn([{ TABLE_NAME: 'x' }]);
      await runMigration182Mysql({ getConnection: vi.fn().mockResolvedValue(conn) } as any);
      const ddl = conn.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(ddl).not.toMatch(/CREATE TABLE/);
    });
  });
});
