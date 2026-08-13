/**
 * Migration 141 tests — reticulum_interfaces table creation.
 */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { migration, runMigration141Postgres, runMigration141Mysql } from './141_create_reticulum_interfaces.js';

describe('Migration 141 — reticulum_interfaces', () => {
  describe('SQLite', () => {
    it('creates the table and unique index, and is idempotent', () => {
      const db = new Database(':memory:');
      migration.up(db);
      expect(() => migration.up(db)).not.toThrow();

      const table = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name = 'reticulum_interfaces'`
      ).get();
      expect(table).toBeTruthy();

      const index = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name = 'reticulum_interfaces_source_name_idx'`
      ).get();
      expect(index).toBeTruthy();
      db.close();
    });

    it('enforces one row per (sourceId, interfaceName)', () => {
      const db = new Database(':memory:');
      migration.up(db);
      const insert = db.prepare(`
        INSERT INTO reticulum_interfaces
          (sourceId, interfaceName, status, online, txBytes, rxBytes, lastSeenAt, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insert.run('src-1', 'TCPClientInterface[rns.example.com]', 'up', 1, 0, 0, 1000, 1000, 1000);
      expect(() =>
        insert.run('src-1', 'TCPClientInterface[rns.example.com]', 'up', 1, 0, 0, 2000, 2000, 2000)
      ).toThrow();
      // Same interfaceName under a different source is allowed.
      expect(() =>
        insert.run('src-2', 'TCPClientInterface[rns.example.com]', 'up', 1, 0, 0, 2000, 2000, 2000)
      ).not.toThrow();
      db.close();
    });
  });

  describe('PostgreSQL', () => {
    it('creates the table with expected columns and index', async () => {
      const client = { query: vi.fn().mockResolvedValue(undefined) };
      await runMigration141Postgres(client as any);
      const sql = client.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(sql).toMatch(/reticulum_interfaces/);
      expect(sql).toMatch(/reticulum_interfaces_source_name_idx/);
      expect(sql).toMatch(/"txBytes" BIGINT/);
      expect(sql).not.toMatch(/frequency|bandwidth|spreadingFactor/i);
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

      await runMigration141Mysql(absentPool as any);

      expect(absentConn.query).toHaveBeenCalled();
      const ddl = absentConn.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(ddl).toMatch(/CREATE TABLE reticulum_interfaces/);
      expect(ddl).toMatch(/UNIQUE KEY reticulum_interfaces_source_name_idx/);
      expect(absentConn.release).toHaveBeenCalled();
    });

    it('skips create when the table already exists', async () => {
      const presentConn = makeConn([{ TABLE_NAME: 'reticulum_interfaces' }]);
      const presentPool = { getConnection: vi.fn().mockResolvedValue(presentConn) };

      await runMigration141Mysql(presentPool as any);

      expect(presentConn.release).toHaveBeenCalled();
    });
  });
});
