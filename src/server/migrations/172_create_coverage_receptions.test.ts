/**
 * Migration 172 tests — coverage_receptions table creation (#5277 Phase 1 WP1).
 */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { migration, runMigration172Postgres, runMigration172Mysql } from './172_create_coverage_receptions.js';

const BASE_ROW = {
  sourceId: 'src-1',
  protocol: 'meshtastic',
  receiverKind: 'local',
  receiverId: '!aaaaaaaa',
  senderId: '!bbbbbbbb',
  packetKey: '100',
  pathKey: 'r0:h0',
  latitude: 12.5,
  longitude: -45.25,
  receivedAt: 1000,
};

describe('Migration 172 — coverage_receptions', () => {
  describe('SQLite', () => {
    it('creates the table and indexes, and is idempotent', () => {
      const db = new Database(':memory:');
      migration.up(db);
      expect(() => migration.up(db)).not.toThrow();

      const table = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name = 'coverage_receptions'`
      ).get();
      expect(table).toBeTruthy();

      const uniqueIdx = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name = 'cov_rx_path_uniq'`
      ).get();
      expect(uniqueIdx).toBeTruthy();

      const receivedIdx = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name = 'cov_rx_received_idx'`
      ).get();
      expect(receivedIdx).toBeTruthy();

      const sourceReceivedIdx = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name = 'cov_rx_source_received_idx'`
      ).get();
      expect(sourceReceivedIdx).toBeTruthy();

      const senderReceivedIdx = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name = 'cov_rx_sender_received_idx'`
      ).get();
      expect(senderReceivedIdx).toBeTruthy();
      db.close();
    });

    it('round-trips a row with an autoincrementing id', () => {
      const db = new Database(':memory:');
      migration.up(db);
      const insert = db.prepare(`
        INSERT INTO coverage_receptions
          (sourceId, protocol, receiverKind, receiverId, senderId, packetKey, pathKey, latitude, longitude, receivedAt)
        VALUES (@sourceId, @protocol, @receiverKind, @receiverId, @senderId, @packetKey, @pathKey, @latitude, @longitude, @receivedAt)
      `);
      const info1 = insert.run(BASE_ROW);
      const info2 = insert.run({ ...BASE_ROW, pathKey: 'r5:h1', receivedAt: 2000 });
      expect(Number(info2.lastInsertRowid)).toBeGreaterThan(Number(info1.lastInsertRowid));

      const rows = db.prepare(
        `SELECT * FROM coverage_receptions WHERE sourceId = ? ORDER BY receivedAt ASC`
      ).all('src-1') as any[];
      expect(rows).toHaveLength(2);
      expect(rows[0].pathKey).toBe('r0:h0');
      expect(rows[1].pathKey).toBe('r5:h1');
      db.close();
    });

    it('enforces the unique constraint on (sourceId, receiverId, senderId, packetKey, pathKey)', () => {
      const db = new Database(':memory:');
      migration.up(db);
      const insert = db.prepare(`
        INSERT INTO coverage_receptions
          (sourceId, protocol, receiverKind, receiverId, senderId, packetKey, pathKey, latitude, longitude, receivedAt)
        VALUES (@sourceId, @protocol, @receiverKind, @receiverId, @senderId, @packetKey, @pathKey, @latitude, @longitude, @receivedAt)
      `);
      insert.run(BASE_ROW);
      expect(() => insert.run(BASE_ROW)).toThrow();
      db.close();
    });

    it('allows the same (sourceId, receiverId, senderId, packetKey) with a different pathKey', () => {
      const db = new Database(':memory:');
      migration.up(db);
      const insert = db.prepare(`
        INSERT INTO coverage_receptions
          (sourceId, protocol, receiverKind, receiverId, senderId, packetKey, pathKey, latitude, longitude, receivedAt)
        VALUES (@sourceId, @protocol, @receiverKind, @receiverId, @senderId, @packetKey, @pathKey, @latitude, @longitude, @receivedAt)
      `);
      insert.run(BASE_ROW);
      expect(() => insert.run({ ...BASE_ROW, pathKey: 'r7:h1' })).not.toThrow();

      const count = db.prepare('SELECT COUNT(*) as c FROM coverage_receptions').get() as { c: number };
      expect(count.c).toBe(2);
      db.close();
    });
  });

  describe('PostgreSQL', () => {
    it('creates the table with expected columns and indexes', async () => {
      const client = { query: vi.fn().mockResolvedValue(undefined) };
      await runMigration172Postgres(client as any);
      const sql = client.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(sql).toMatch(/coverage_receptions/);
      expect(sql).toMatch(/cov_rx_path_uniq/);
      expect(sql).toMatch(/cov_rx_received_idx/);
      expect(sql).toMatch(/cov_rx_source_received_idx/);
      expect(sql).toMatch(/cov_rx_sender_received_idx/);
      expect(sql).toMatch(/"sourceId" TEXT NOT NULL/);
      expect(sql).toMatch(/"receiverId" TEXT NOT NULL/);
      expect(sql).toMatch(/"senderId" TEXT NOT NULL/);
      expect(sql).toMatch(/"packetKey" TEXT NOT NULL/);
      expect(sql).toMatch(/"pathKey" TEXT NOT NULL/);
      expect(sql).toMatch(/"receiverNodeNum" BIGINT/);
      expect(sql).toMatch(/"senderNodeNum" BIGINT/);
      expect(sql).toMatch(/"packetId" BIGINT/);
      expect(sql).toMatch(/"receivedAt" BIGINT NOT NULL/);
      expect(sql).toMatch(/latitude DOUBLE PRECISION NOT NULL/);
      expect(sql).toMatch(/longitude DOUBLE PRECISION NOT NULL/);
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

      await runMigration172Mysql(absentPool as any);

      expect(absentConn.query).toHaveBeenCalled();
      const ddl = absentConn.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(ddl).toMatch(/CREATE TABLE coverage_receptions/);
      expect(ddl).toMatch(/UNIQUE KEY cov_rx_path_uniq/);
      expect(ddl).toMatch(/INDEX cov_rx_received_idx/);
      expect(ddl).toMatch(/INDEX cov_rx_source_received_idx/);
      expect(ddl).toMatch(/INDEX cov_rx_sender_received_idx/);
      expect(ddl).toMatch(/sourceId VARCHAR\(64\) NOT NULL/);
      expect(ddl).toMatch(/receiverId VARCHAR\(80\) NOT NULL/);
      expect(ddl).toMatch(/senderId VARCHAR\(80\) NOT NULL/);
      expect(ddl).toMatch(/packetKey VARCHAR\(80\) NOT NULL/);
      expect(ddl).toMatch(/pathKey VARCHAR\(80\) NOT NULL/);
      expect(absentConn.release).toHaveBeenCalled();
    });

    it('skips create when the table already exists', async () => {
      const presentConn = makeConn([{ TABLE_NAME: 'coverage_receptions' }]);
      const presentPool = { getConnection: vi.fn().mockResolvedValue(presentConn) };

      await runMigration172Mysql(presentPool as any);

      expect(presentConn.release).toHaveBeenCalled();
    });
  });
});
