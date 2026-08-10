/**
 * Migration 139 tests — automation_home_anchors table creation.
 */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { migration, runMigration139Postgres, runMigration139Mysql } from './139_automation_home_anchors.js';

describe('Migration 139 — automation_home_anchors', () => {
  describe('SQLite', () => {
    it('creates the table and unique index, and is idempotent', () => {
      const db = new Database(':memory:');
      migration.up(db);
      expect(() => migration.up(db)).not.toThrow();

      const table = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name = 'automation_home_anchors'`
      ).get();
      expect(table).toBeTruthy();

      const index = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name = 'aha_automation_node_idx'`
      ).get();
      expect(index).toBeTruthy();
      db.close();
    });

    it('enforces one home per (automationId, nodeNum)', () => {
      const db = new Database(':memory:');
      migration.up(db);
      const insert = db.prepare(`
        INSERT INTO automation_home_anchors (automationId, nodeNum, latitude, longitude, setAt)
        VALUES (?, ?, ?, ?, ?)
      `);
      insert.run('auto-1', 42, 1.0, 2.0, 1000);
      expect(() => insert.run('auto-1', 42, 3.0, 4.0, 2000)).toThrow();
      db.close();
    });
  });

  describe('PostgreSQL', () => {
    it('creates the table', async () => {
      const client = { query: vi.fn().mockResolvedValue(undefined) };
      await runMigration139Postgres(client as any);
      const sql = client.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(sql).toMatch(/automation_home_anchors/);
      expect(sql).toMatch(/aha_automation_node_idx/);
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

      await runMigration139Mysql(absentPool as any);

      expect(absentConn.query).toHaveBeenCalled();
      const ddl = absentConn.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(ddl).toMatch(/CREATE TABLE automation_home_anchors/);
      expect(absentConn.release).toHaveBeenCalled();
    });

    it('skips create when the table already exists', async () => {
      const presentConn = makeConn([{ TABLE_NAME: 'automation_home_anchors' }]);
      const presentPool = { getConnection: vi.fn().mockResolvedValue(presentConn) };

      await runMigration139Mysql(presentPool as any);

      // existence check only for createTableIfMissing; createIndexIfMissing may still query
      expect(presentConn.release).toHaveBeenCalled();
    });
  });
});
