/**
 * Migration 151 tests — message_events table creation (#4816 Phase 3 WP1).
 */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { migration, runMigration151Postgres, runMigration151Mysql } from './151_create_message_events.js';

describe('Migration 151 — message_events', () => {
  describe('SQLite', () => {
    it('creates the table and index, and is idempotent', () => {
      const db = new Database(':memory:');
      migration.up(db);
      expect(() => migration.up(db)).not.toThrow();

      const table = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name = 'message_events'`
      ).get();
      expect(table).toBeTruthy();

      const idx = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_message_events_source_message'`
      ).get();
      expect(idx).toBeTruthy();
      db.close();
    });

    it('round-trips a row with an autoincrementing id', () => {
      const db = new Database(':memory:');
      migration.up(db);
      const insert = db.prepare(`
        INSERT INTO message_events
          (sourceId, messageId, eventType, provenance, detail, timestamp, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const info1 = insert.run('src-1', 'msg-1', 'submitted', 'reported', null, 1000, 1000);
      const info2 = insert.run('src-1', 'msg-1', 'delivered', 'reported', '{"roundTripMs":250}', 2000, 2000);
      expect(Number(info2.lastInsertRowid)).toBeGreaterThan(Number(info1.lastInsertRowid));

      const rows = db.prepare(
        `SELECT * FROM message_events WHERE sourceId = ? AND messageId = ? ORDER BY timestamp ASC`
      ).all('src-1', 'msg-1') as any[];
      expect(rows).toHaveLength(2);
      expect(rows[0].eventType).toBe('submitted');
      expect(rows[0].detail).toBeNull();
      expect(rows[1].eventType).toBe('delivered');
      expect(rows[1].detail).toBe('{"roundTripMs":250}');
      db.close();
    });

    it('allows multiple messages/sources without collision', () => {
      const db = new Database(':memory:');
      migration.up(db);
      const insert = db.prepare(`
        INSERT INTO message_events
          (sourceId, messageId, eventType, provenance, detail, timestamp, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      insert.run('src-1', 'msg-1', 'submitted', 'reported', null, 1000, 1000);
      insert.run('src-2', 'msg-1', 'submitted', 'reported', null, 1000, 1000);
      insert.run('src-1', 'msg-2', 'submitted', 'reported', null, 1000, 1000);

      const count = db.prepare('SELECT COUNT(*) as c FROM message_events').get() as { c: number };
      expect(count.c).toBe(3);
      db.close();
    });
  });

  describe('PostgreSQL', () => {
    it('creates the table with expected columns and index', async () => {
      const client = { query: vi.fn().mockResolvedValue(undefined) };
      await runMigration151Postgres(client as any);
      const sql = client.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(sql).toMatch(/message_events/);
      expect(sql).toMatch(/idx_message_events_source_message/);
      expect(sql).toMatch(/"timestamp" BIGINT/);
      expect(sql).toMatch(/"createdAt" BIGINT/);
      expect(sql).toMatch(/"sourceId" TEXT NOT NULL/);
      expect(sql).toMatch(/"messageId" TEXT NOT NULL/);
    });
  });

  describe('MySQL', () => {
    function makeConn(existRows: any[]) {
      return {
        query: vi.fn().mockResolvedValue([existRows, []]),
        release: vi.fn(),
      };
    }

    it('creates the table when missing', async () => {
      const absentConn = makeConn([]);
      const absentPool = { getConnection: vi.fn().mockResolvedValue(absentConn) };

      await runMigration151Mysql(absentPool as any);

      expect(absentConn.query).toHaveBeenCalled();
      const ddl = absentConn.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(ddl).toMatch(/CREATE TABLE message_events/);
      expect(ddl).toMatch(/INDEX idx_message_events_source_message/);
      expect(absentConn.release).toHaveBeenCalled();
    });

    it('skips create when the table already exists', async () => {
      const presentConn = makeConn([{ TABLE_NAME: 'message_events' }]);
      const presentPool = { getConnection: vi.fn().mockResolvedValue(presentConn) };

      await runMigration151Mysql(presentPool as any);

      expect(presentConn.release).toHaveBeenCalled();
    });
  });
});
