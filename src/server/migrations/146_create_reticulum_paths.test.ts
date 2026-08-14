/**
 * Migration 146 tests — reticulum_paths table creation.
 */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { migration, runMigration146Postgres, runMigration146Mysql } from './146_create_reticulum_paths.js';

describe('Migration 146 — reticulum_paths', () => {
  describe('SQLite', () => {
    it('creates the table and indexes, and is idempotent', () => {
      const db = new Database(':memory:');
      migration.up(db);
      expect(() => migration.up(db)).not.toThrow();

      const table = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name = 'reticulum_paths'`
      ).get();
      expect(table).toBeTruthy();

      const sourceDestIdx = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name = 'reticulum_paths_source_dest_idx'`
      ).get();
      expect(sourceDestIdx).toBeTruthy();

      const sourceUpdatedIdx = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name = 'reticulum_paths_source_updated_idx'`
      ).get();
      expect(sourceUpdatedIdx).toBeTruthy();
      db.close();
    });

    it('has all expected columns', () => {
      const db = new Database(':memory:');
      migration.up(db);
      const columns = db.prepare(`PRAGMA table_info(reticulum_paths)`).all() as Array<{ name: string }>;
      const names = columns.map((c) => c.name).sort();
      expect(names).toEqual(
        ['destinationHash', 'expiresAt', 'hops', 'id', 'interfaceName', 'sourceId', 'updatedAt', 'viaHash'].sort(),
      );
      db.close();
    });

    it('enforces one row per (sourceId, destinationHash)', () => {
      const db = new Database(':memory:');
      migration.up(db);
      const insert = db.prepare(`
        INSERT INTO reticulum_paths
          (sourceId, destinationHash, viaHash, hops, interfaceName, expiresAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      insert.run('src-1', 'dest-hash-' + 'a'.repeat(20), 'via-hash-' + 'b'.repeat(20), 2, 'TCPClientInterface[a]', 2000, 1000);
      expect(() =>
        insert.run('src-1', 'dest-hash-' + 'a'.repeat(20), 'via-hash-' + 'c'.repeat(20), 3, 'TCPClientInterface[b]', 3000, 2000)
      ).toThrow();
      // Same destinationHash under a different source is allowed.
      expect(() =>
        insert.run('src-2', 'dest-hash-' + 'a'.repeat(20), null, null, null, null, 2000)
      ).not.toThrow();
      db.close();
    });

    it('round-trips nullable columns', () => {
      const db = new Database(':memory:');
      migration.up(db);
      db.prepare(`
        INSERT INTO reticulum_paths
          (sourceId, destinationHash, viaHash, hops, interfaceName, expiresAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('src-1', 'dest-hash-' + 'd'.repeat(20), null, null, null, null, 1000);
      const row = db.prepare('SELECT * FROM reticulum_paths WHERE destinationHash = ?').get('dest-hash-' + 'd'.repeat(20)) as any;
      expect(row.viaHash).toBeNull();
      expect(row.hops).toBeNull();
      expect(row.interfaceName).toBeNull();
      expect(row.expiresAt).toBeNull();
      expect(row.updatedAt).toBe(1000);
      db.close();
    });
  });

  describe('PostgreSQL', () => {
    it('creates the table with expected columns and indexes', async () => {
      const client = { query: vi.fn().mockResolvedValue(undefined) };
      await runMigration146Postgres(client as any);
      const sql = client.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(sql).toMatch(/reticulum_paths/);
      expect(sql).toMatch(/reticulum_paths_source_dest_idx/);
      expect(sql).toMatch(/reticulum_paths_source_updated_idx/);
      expect(sql).toMatch(/"expiresAt" BIGINT/);
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

      await runMigration146Mysql(absentPool as any);

      expect(absentConn.query).toHaveBeenCalled();
      const ddl = absentConn.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(ddl).toMatch(/CREATE TABLE reticulum_paths/);
      expect(ddl).toMatch(/UNIQUE KEY reticulum_paths_source_dest_idx/);
      expect(absentConn.release).toHaveBeenCalled();
    });

    it('skips create when the table already exists', async () => {
      const presentConn = makeConn([{ TABLE_NAME: 'reticulum_paths' }]);
      const presentPool = { getConnection: vi.fn().mockResolvedValue(presentConn) };

      await runMigration146Mysql(presentPool as any);

      expect(presentConn.release).toHaveBeenCalled();
    });
  });
});
