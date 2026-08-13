/**
 * Migration 143 tests — reticulum_messages table creation.
 */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { migration, runMigration143Postgres, runMigration143Mysql } from './143_create_reticulum_messages.js';

describe('Migration 143 — reticulum_messages', () => {
  describe('SQLite', () => {
    it('creates the table and indexes, and is idempotent', () => {
      const db = new Database(':memory:');
      migration.up(db);
      expect(() => migration.up(db)).not.toThrow();

      const table = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name = 'reticulum_messages'`
      ).get();
      expect(table).toBeTruthy();

      const sourceToFromTsIdx = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name = 'reticulum_messages_source_to_from_ts_idx'`
      ).get();
      expect(sourceToFromTsIdx).toBeTruthy();

      const sourceThreadIdx = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name = 'reticulum_messages_source_thread_idx'`
      ).get();
      expect(sourceThreadIdx).toBeTruthy();
      db.close();
    });

    it('enforces the composite id primary key', () => {
      const db = new Database(':memory:');
      migration.up(db);
      const insert = db.prepare(`
        INSERT INTO reticulum_messages
          (id, sourceId, fromHash, toHash, timestamp, createdAt, state)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      insert.run('src-1_' + 'a'.repeat(32), 'src-1', 'f'.repeat(32), 't'.repeat(32), 1000, 1000, 'delivered');
      expect(() =>
        insert.run('src-1_' + 'a'.repeat(32), 'src-1', 'f'.repeat(32), 't'.repeat(32), 2000, 2000, 'delivered')
      ).toThrow();
      // Same lxm hash under a different source id produces a different composite id.
      expect(() =>
        insert.run('src-2_' + 'a'.repeat(32), 'src-2', 'f'.repeat(32), 't'.repeat(32), 2000, 2000, 'delivered')
      ).not.toThrow();
      db.close();
    });

    it('round-trips optional/boolean columns', () => {
      const db = new Database(':memory:');
      migration.up(db);
      db.prepare(`
        INSERT INTO reticulum_messages
          (id, sourceId, fromHash, toHash, title, content, timestamp, receivedAt, createdAt,
           state, method, signatureValidated, ratcheted, fields, replyToHash, threadHash, rssi, snr, quality)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'src-1_' + 'b'.repeat(32), 'src-1', 'f'.repeat(32), 't'.repeat(32), 'hi', 'hello world',
        1000, 1500, 1000, 'delivered', 'direct', 1, 0, '{"attachments":[]}',
        null, 'thread-1', -70, 3.25, 80,
      );
      const row = db.prepare('SELECT * FROM reticulum_messages WHERE id = ?').get('src-1_' + 'b'.repeat(32)) as any;
      expect(row.title).toBe('hi');
      expect(row.signatureValidated).toBe(1);
      expect(row.ratcheted).toBe(0);
      expect(row.threadHash).toBe('thread-1');
      expect(row.snr).toBeCloseTo(3.25);
      db.close();
    });
  });

  describe('PostgreSQL', () => {
    it('creates the table with expected columns and indexes', async () => {
      const client = { query: vi.fn().mockResolvedValue(undefined) };
      await runMigration143Postgres(client as any);
      const sql = client.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(sql).toMatch(/reticulum_messages/);
      expect(sql).toMatch(/reticulum_messages_source_to_from_ts_idx/);
      expect(sql).toMatch(/reticulum_messages_source_thread_idx/);
      expect(sql).toMatch(/"timestamp" BIGINT/);
      expect(sql).toMatch(/"signatureValidated" BOOLEAN/);
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

      await runMigration143Mysql(absentPool as any);

      expect(absentConn.query).toHaveBeenCalled();
      const ddl = absentConn.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(ddl).toMatch(/CREATE TABLE reticulum_messages/);
      expect(absentConn.release).toHaveBeenCalled();
    });

    it('skips create when the table already exists', async () => {
      const presentConn = makeConn([{ TABLE_NAME: 'reticulum_messages' }]);
      const presentPool = { getConnection: vi.fn().mockResolvedValue(presentConn) };

      await runMigration143Mysql(presentPool as any);

      expect(presentConn.release).toHaveBeenCalled();
    });
  });
});
