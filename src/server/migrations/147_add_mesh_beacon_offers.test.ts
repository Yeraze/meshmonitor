import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { migration, runMigration147Postgres, runMigration147Mysql } from './147_add_mesh_beacon_offers.js';

describe('Migration 147 — mesh_beacon_offers table', () => {
  describe('SQLite', () => {
    it('creates the table and is idempotent (second up() does not throw)', () => {
      // Idempotency is mandatory on every backend: a crash between the
      // migration and its ledger write re-runs it (see #4233).
      const db = new Database(':memory:');

      migration.up(db);
      expect(() => migration.up(db)).not.toThrow();

      const table = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name = 'mesh_beacon_offers'`
      ).get();
      expect(table).toBeTruthy();

      const indexes = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = 'mesh_beacon_offers'`
      ).all() as Array<{ name: string }>;
      expect(indexes.map((i) => i.name)).toContain('idx_mesh_beacon_offers_lastSeenAt');

      db.close();
    });

    it('round-trips a row and enforces the composite PK', () => {
      const db = new Database(':memory:');
      migration.up(db);

      const insert = () => db.prepare(`
        INSERT INTO mesh_beacon_offers (
          sourceId, nodeNum, message, offerChannelName, offerRegion, offerPreset,
          hasOffer, firstSeenAt, lastSeenAt, dismissedAt
        ) VALUES ('src-a', 2863311530, 'join us', 'RegionMesh', 1, 2, 1, 1000, 2000, NULL)
      `).run();

      insert();
      // (sourceId, nodeNum) is the PK — a duplicate must be rejected, which is
      // what makes the upsert path a genuine upsert rather than an append.
      expect(insert).toThrow();

      const row = db.prepare(`SELECT * FROM mesh_beacon_offers`).get() as Record<string, unknown>;
      expect(row).toMatchObject({
        sourceId: 'src-a', nodeNum: 2863311530, offerChannelName: 'RegionMesh',
        hasOffer: 1, firstSeenAt: 1000, lastSeenAt: 2000, dismissedAt: null,
      });

      db.close();
    });

    it('accepts a node number above the signed 32-bit range', () => {
      // nodeNum is unsigned 32-bit; 0xFFFFFFFE would overflow a signed INTEGER
      // on the other two backends, which is why they use BIGINT.
      const db = new Database(':memory:');
      migration.up(db);
      db.prepare(`
        INSERT INTO mesh_beacon_offers (sourceId, nodeNum, hasOffer, firstSeenAt, lastSeenAt)
        VALUES ('src-a', 4294967294, 0, 1, 1)
      `).run();
      const row = db.prepare(`SELECT nodeNum FROM mesh_beacon_offers`).get() as { nodeNum: number };
      expect(row.nodeNum).toBe(4294967294);
      db.close();
    });

    it('drops the table on down()', () => {
      const db = new Database(':memory:');
      migration.up(db);
      migration.down(db);
      const table = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name = 'mesh_beacon_offers'`
      ).get();
      expect(table).toBeFalsy();
      db.close();
    });
  });

  describe('PostgreSQL', () => {
    it('issues CREATE TABLE IF NOT EXISTS with BIGINT nodeNum and quoted camelCase', async () => {
      const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
      await runMigration147Postgres(client as never);

      const sql = client.query.mock.calls.map((c) => String(c[0])).join('\n');
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS mesh_beacon_offers');
      // PG needs camelCase identifiers quoted, and nodeNum/timestamps as BIGINT.
      expect(sql).toContain('"nodeNum" BIGINT NOT NULL');
      expect(sql).toContain('"firstSeenAt" BIGINT NOT NULL');
      expect(sql).toContain('"lastSeenAt" BIGINT NOT NULL');
      expect(sql).toContain('"dismissedAt" BIGINT');
      expect(sql).toContain('"hasOffer" BOOLEAN');
      expect(sql).toContain('PRIMARY KEY ("sourceId", "nodeNum")');
      expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_mesh_beacon_offers_lastSeenAt');
    });
  });

  describe('MySQL', () => {
    function makeConn(existRows: unknown[]) {
      return {
        query: vi.fn().mockResolvedValue([existRows, []]),
        release: vi.fn(),
      };
    }

    it('creates the table when absent, then skips create when present', async () => {
      // MySQL has no CREATE TABLE IF NOT EXISTS here — idempotency comes from
      // the helper's information_schema pre-check, so both halves are asserted.
      const absentConn = makeConn([]);
      await runMigration147Mysql({ getConnection: vi.fn().mockResolvedValue(absentConn) } as never);

      expect(absentConn.query).toHaveBeenCalledTimes(2);
      const createSql = String(absentConn.query.mock.calls[1][0]);
      expect(createSql).toContain('CREATE TABLE mesh_beacon_offers');
      // PK columns must be bounded length in MySQL, never TEXT.
      expect(createSql).toContain('sourceId VARCHAR(191) NOT NULL');
      // nodeNum is unsigned 32-bit — INT would overflow.
      expect(createSql).toContain('nodeNum BIGINT NOT NULL');
      expect(createSql).toContain('PRIMARY KEY (sourceId, nodeNum)');
      // Index must be inline: MySQL lacks CREATE INDEX IF NOT EXISTS.
      expect(createSql).toContain('INDEX idx_mesh_beacon_offers_lastSeenAt');
      expect(absentConn.release).toHaveBeenCalledTimes(1);

      const presentConn = makeConn([{ TABLE_NAME: 'mesh_beacon_offers' }]);
      await runMigration147Mysql({ getConnection: vi.fn().mockResolvedValue(presentConn) } as never);

      expect(presentConn.query).toHaveBeenCalledTimes(1); // existence check only
      expect(presentConn.release).toHaveBeenCalledTimes(1);
    });
  });
});
