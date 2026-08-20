/**
 * Migration 152 tests — meshtastic_heard_repeaters table creation (#4816
 * Phase 4 WP1).
 */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { migration, runMigration152Postgres, runMigration152Mysql } from './152_create_meshtastic_heard_repeaters.js';

describe('Migration 152 — meshtastic_heard_repeaters', () => {
  describe('SQLite', () => {
    it('creates the table and indexes, and is idempotent', () => {
      const db = new Database(':memory:');
      migration.up(db);
      expect(() => migration.up(db)).not.toThrow();

      const table = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name = 'meshtastic_heard_repeaters'`
      ).get();
      expect(table).toBeTruthy();

      const uniqueIdx = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name = 'mthr_source_msg_relay_uniq'`
      ).get();
      expect(uniqueIdx).toBeTruthy();

      const idx = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name = 'mthr_source_msg_idx'`
      ).get();
      expect(idx).toBeTruthy();
      db.close();
    });

    it('round-trips a row with an autoincrementing id and a fractional SNR', () => {
      const db = new Database(':memory:');
      migration.up(db);
      const insert = db.prepare(`
        INSERT INTO meshtastic_heard_repeaters
          (sourceId, messageId, relayByte, snr, heardAt, createdAt)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const info1 = insert.run('src-1', 'msg-1', 0xa3, -7.25, 1000, 1000);
      const info2 = insert.run('src-1', 'msg-1', 0x7f, -3.5, 2000, 2000);
      expect(Number(info2.lastInsertRowid)).toBeGreaterThan(Number(info1.lastInsertRowid));

      const rows = db.prepare(
        `SELECT * FROM meshtastic_heard_repeaters WHERE sourceId = ? AND messageId = ? ORDER BY relayByte ASC`
      ).all('src-1', 'msg-1') as any[];
      expect(rows).toHaveLength(2);
      expect(rows[0].relayByte).toBe(0x7f);
      expect(rows[0].snr).toBe(-3.5);
      expect(rows[1].relayByte).toBe(0xa3);
      expect(rows[1].snr).toBe(-7.25);
      db.close();
    });

    it('enforces the unique constraint on (sourceId, messageId, relayByte)', () => {
      const db = new Database(':memory:');
      migration.up(db);
      const insert = db.prepare(`
        INSERT INTO meshtastic_heard_repeaters
          (sourceId, messageId, relayByte, snr, heardAt, createdAt)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      insert.run('src-1', 'msg-1', 0xa3, -7.25, 1000, 1000);
      expect(() => insert.run('src-1', 'msg-1', 0xa3, -3.5, 2000, 2000)).toThrow();
      db.close();
    });

    it('allows multiple messages/sources without collision', () => {
      const db = new Database(':memory:');
      migration.up(db);
      const insert = db.prepare(`
        INSERT INTO meshtastic_heard_repeaters
          (sourceId, messageId, relayByte, snr, heardAt, createdAt)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      insert.run('src-1', 'msg-1', 0xa3, null, 1000, 1000);
      insert.run('src-2', 'msg-1', 0xa3, null, 1000, 1000);
      insert.run('src-1', 'msg-2', 0xa3, null, 1000, 1000);

      const count = db.prepare('SELECT COUNT(*) as c FROM meshtastic_heard_repeaters').get() as { c: number };
      expect(count.c).toBe(3);
      db.close();
    });
  });

  describe('PostgreSQL', () => {
    it('creates the table with expected columns and indexes', async () => {
      const client = { query: vi.fn().mockResolvedValue(undefined) };
      await runMigration152Postgres(client as any);
      const sql = client.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(sql).toMatch(/meshtastic_heard_repeaters/);
      expect(sql).toMatch(/mthr_source_msg_relay_uniq/);
      expect(sql).toMatch(/mthr_source_msg_idx/);
      expect(sql).toMatch(/"heardAt" BIGINT/);
      expect(sql).toMatch(/"createdAt" BIGINT/);
      expect(sql).toMatch(/"sourceId" TEXT NOT NULL/);
      expect(sql).toMatch(/"messageId" TEXT NOT NULL/);
      expect(sql).toMatch(/"relayByte" INTEGER NOT NULL/);
      expect(sql).toMatch(/snr REAL/);
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

      await runMigration152Mysql(absentPool as any);

      expect(absentConn.query).toHaveBeenCalled();
      const ddl = absentConn.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(ddl).toMatch(/CREATE TABLE meshtastic_heard_repeaters/);
      expect(ddl).toMatch(/UNIQUE KEY mthr_source_msg_relay_uniq/);
      expect(ddl).toMatch(/INDEX mthr_source_msg_idx/);
      expect(ddl).toMatch(/snr DOUBLE/);
      expect(absentConn.release).toHaveBeenCalled();
    });

    it('skips create when the table already exists', async () => {
      const presentConn = makeConn([{ TABLE_NAME: 'meshtastic_heard_repeaters' }]);
      const presentPool = { getConnection: vi.fn().mockResolvedValue(presentConn) };

      await runMigration152Mysql(presentPool as any);

      expect(presentConn.release).toHaveBeenCalled();
    });
  });
});
