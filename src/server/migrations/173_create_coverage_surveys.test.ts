/**
 * Migration 173 tests — coverage_surveys table creation (#5277 Phase 4b WP1).
 */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { migration, runMigration173Postgres, runMigration173Mysql } from './173_create_coverage_surveys.js';

const BASE_ROW = {
  id: 'a0000000-0000-4000-8000-000000000001',
  name: 'Test drive',
  senderId: '!aaaaaaaa',
  startAt: 1000,
  createdAt: 1000,
  updatedAt: 1000,
};

describe('Migration 173 — coverage_surveys', () => {
  describe('SQLite', () => {
    it('creates the table and indexes, and is idempotent', () => {
      const db = new Database(':memory:');
      migration.up(db);
      expect(() => migration.up(db)).not.toThrow();

      const table = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name = 'coverage_surveys'`
      ).get();
      expect(table).toBeTruthy();

      const senderStartIdx = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name = 'cov_sv_sender_start_idx'`
      ).get();
      expect(senderStartIdx).toBeTruthy();

      const createdByIdx = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name = 'cov_sv_created_by_idx'`
      ).get();
      expect(createdByIdx).toBeTruthy();
      db.close();
    });

    it('round-trips a row with nullable columns omitted', () => {
      const db = new Database(':memory:');
      migration.up(db);
      const insert = db.prepare(`
        INSERT INTO coverage_surveys (id, name, senderId, startAt, createdAt, updatedAt)
        VALUES (@id, @name, @senderId, @startAt, @createdAt, @updatedAt)
      `);
      insert.run(BASE_ROW);

      const row = db.prepare(`SELECT * FROM coverage_surveys WHERE id = ?`).get(BASE_ROW.id) as any;
      expect(row.name).toBe('Test drive');
      expect(row.senderId).toBe('!aaaaaaaa');
      expect(row.endAt).toBeNull();
      expect(row.receivers).toBeNull();
      expect(row.intervalSec).toBeNull();
      expect(row.notes).toBeNull();
      expect(row.createdBy).toBeNull();
      db.close();
    });

    it('a duplicate id (same TEXT PRIMARY KEY) is rejected', () => {
      const db = new Database(':memory:');
      migration.up(db);
      const insert = db.prepare(`
        INSERT INTO coverage_surveys (id, name, senderId, startAt, createdAt, updatedAt)
        VALUES (@id, @name, @senderId, @startAt, @createdAt, @updatedAt)
      `);
      insert.run(BASE_ROW);
      expect(() => insert.run(BASE_ROW)).toThrow();
      db.close();
    });

    it('two different ids for the same sender both survive (no unique constraint on senderId)', () => {
      const db = new Database(':memory:');
      migration.up(db);
      const insert = db.prepare(`
        INSERT INTO coverage_surveys (id, name, senderId, startAt, createdAt, updatedAt)
        VALUES (@id, @name, @senderId, @startAt, @createdAt, @updatedAt)
      `);
      insert.run(BASE_ROW);
      expect(() => insert.run({ ...BASE_ROW, id: 'a0000000-0000-4000-8000-000000000002', startAt: 2000 })).not.toThrow();

      const count = db.prepare('SELECT COUNT(*) as c FROM coverage_surveys').get() as { c: number };
      expect(count.c).toBe(2);
      db.close();
    });
  });

  describe('PostgreSQL', () => {
    it('creates the table with expected columns and indexes', async () => {
      const client = { query: vi.fn().mockResolvedValue(undefined) };
      await runMigration173Postgres(client as any);
      const sql = client.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(sql).toMatch(/coverage_surveys/);
      expect(sql).toMatch(/cov_sv_sender_start_idx/);
      expect(sql).toMatch(/cov_sv_created_by_idx/);
      expect(sql).toMatch(/id TEXT PRIMARY KEY/);
      expect(sql).toMatch(/name TEXT NOT NULL/);
      expect(sql).toMatch(/"senderId" TEXT NOT NULL/);
      expect(sql).toMatch(/"startAt" BIGINT NOT NULL/);
      expect(sql).toMatch(/"endAt" BIGINT/);
      expect(sql).toMatch(/"intervalSec" INTEGER/);
      expect(sql).toMatch(/"createdBy" INTEGER/);
      expect(sql).toMatch(/"createdAt" BIGINT NOT NULL/);
      expect(sql).toMatch(/"updatedAt" BIGINT NOT NULL/);
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

      await runMigration173Mysql(absentPool as any);

      expect(absentConn.query).toHaveBeenCalled();
      const ddl = absentConn.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(ddl).toMatch(/CREATE TABLE coverage_surveys/);
      expect(ddl).toMatch(/INDEX cov_sv_sender_start_idx/);
      expect(ddl).toMatch(/INDEX cov_sv_created_by_idx/);
      expect(ddl).toMatch(/id VARCHAR\(36\) PRIMARY KEY/);
      expect(ddl).toMatch(/name VARCHAR\(120\) NOT NULL/);
      expect(ddl).toMatch(/senderId VARCHAR\(80\) NOT NULL/);
      expect(absentConn.release).toHaveBeenCalled();
    });

    it('skips create when the table already exists', async () => {
      const presentConn = makeConn([{ TABLE_NAME: 'coverage_surveys' }]);
      const presentPool = { getConnection: vi.fn().mockResolvedValue(presentConn) };

      await runMigration173Mysql(presentPool as any);

      expect(presentConn.release).toHaveBeenCalled();
    });
  });
});
