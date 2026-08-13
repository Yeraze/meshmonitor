/**
 * Migration 141 tests — reticulum_destinations table creation.
 */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { migration, runMigration141Postgres, runMigration141Mysql } from './141_create_reticulum_destinations.js';

describe('Migration 141 — reticulum_destinations', () => {
  describe('SQLite', () => {
    it('creates the table and indexes, and is idempotent', () => {
      const db = new Database(':memory:');
      migration.up(db);
      expect(() => migration.up(db)).not.toThrow();

      const table = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name = 'reticulum_destinations'`
      ).get();
      expect(table).toBeTruthy();

      const uniqIdx = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name = 'reticulum_destinations_source_hash_idx'`
      ).get();
      expect(uniqIdx).toBeTruthy();

      const lastSeenIdx = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name = 'reticulum_destinations_source_lastseen_idx'`
      ).get();
      expect(lastSeenIdx).toBeTruthy();
      db.close();
    });

    it('enforces one row per (sourceId, destinationHash)', () => {
      const db = new Database(':memory:');
      migration.up(db);
      const insert = db.prepare(`
        INSERT INTO reticulum_destinations
          (sourceId, destinationHash, announceCount, firstSeen, lastSeen, isFavorite, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insert.run('src-1', 'a'.repeat(32), 1, 1000, 1000, 0, 1000, 1000);
      expect(() => insert.run('src-1', 'a'.repeat(32), 1, 2000, 2000, 0, 2000, 2000)).toThrow();
      // Same hash under a different source is allowed.
      expect(() => insert.run('src-2', 'a'.repeat(32), 1, 2000, 2000, 0, 2000, 2000)).not.toThrow();
      db.close();
    });

    it('carries the rssi/snr/quality signal columns (Phase 1a)', () => {
      const db = new Database(':memory:');
      migration.up(db);
      db.prepare(`
        INSERT INTO reticulum_destinations
          (sourceId, destinationHash, rssi, snr, quality, announceCount, firstSeen, lastSeen, isFavorite, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('src-1', 'b'.repeat(32), -80, 4.5, 90, 1, 1000, 1000, 0, 1000, 1000);

      const row: any = db.prepare(`SELECT * FROM reticulum_destinations WHERE destinationHash = ?`).get('b'.repeat(32));
      expect(row.rssi).toBe(-80);
      expect(row.snr).toBeCloseTo(4.5);
      expect(row.quality).toBe(90);
      db.close();
    });
  });

  describe('PostgreSQL', () => {
    it('creates the table with expected columns and indexes', async () => {
      const client = { query: vi.fn().mockResolvedValue(undefined) };
      await runMigration141Postgres(client as any);
      const sql = client.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(sql).toMatch(/reticulum_destinations/);
      expect(sql).toMatch(/reticulum_destinations_source_hash_idx/);
      expect(sql).toMatch(/reticulum_destinations_source_lastseen_idx/);
      expect(sql).toMatch(/rssi INTEGER/);
      expect(sql).toMatch(/snr DOUBLE PRECISION/);
      expect(sql).not.toMatch(/latitude/i);
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
      expect(ddl).toMatch(/CREATE TABLE reticulum_destinations/);
      expect(ddl).toMatch(/UNIQUE KEY reticulum_destinations_source_hash_idx/);
      expect(absentConn.release).toHaveBeenCalled();
    });

    it('skips create when the table already exists', async () => {
      const presentConn = makeConn([{ TABLE_NAME: 'reticulum_destinations' }]);
      const presentPool = { getConnection: vi.fn().mockResolvedValue(presentConn) };

      await runMigration141Mysql(presentPool as any);

      expect(presentConn.release).toHaveBeenCalled();
    });
  });
});
