import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { migration, runMigration127Postgres, runMigration127Mysql } from './127_add_atak_contacts.js';

describe('Migration 127 — atak_contacts table', () => {
  describe('SQLite', () => {
    it('creates the table and is idempotent (second up() does not throw)', () => {
      const db = new Database(':memory:');

      migration.up(db);
      expect(() => migration.up(db)).not.toThrow();

      const table = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name = 'atak_contacts'`
      ).get();
      expect(table).toBeTruthy();

      const indexes = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = 'atak_contacts'`
      ).all() as Array<{ name: string }>;
      const indexNames = indexes.map((i) => i.name);
      expect(indexNames).toContain('idx_atak_contacts_source_lastseen');
      expect(indexNames).toContain('idx_atak_contacts_source_node');

      db.close();
    });

    it('round-trips a full row insert/read with composite PK enforced', () => {
      const db = new Database(':memory:');
      migration.up(db);

      const now = Date.now();
      db.prepare(`
        INSERT INTO atak_contacts (
          uid, sourceId, nodeNum, callsign, deviceCallsign, team, role,
          battery, latitude, longitude, altitude, speed, course, lastSeen, createdAt
        ) VALUES (
          @uid, @sourceId, @nodeNum, @callsign, @deviceCallsign, @team, @role,
          @battery, @latitude, @longitude, @altitude, @speed, @course, @lastSeen, @createdAt
        )
      `).run({
        uid: 'EUD-001',
        sourceId: 'source-a',
        nodeNum: 0xaabbccdd,
        callsign: 'ALPHA-1',
        deviceCallsign: 'EUD-001',
        team: 9,
        role: 1,
        battery: 85,
        latitude: 38.8895,
        longitude: -77.0353,
        altitude: 12,
        speed: 3,
        course: 270,
        lastSeen: now,
        createdAt: now,
      });

      const row = db.prepare(`SELECT * FROM atak_contacts WHERE uid = 'EUD-001' AND sourceId = 'source-a'`).get() as any;
      expect(row).toBeTruthy();
      expect(row.callsign).toBe('ALPHA-1');
      expect(row.team).toBe(9);
      expect(row.latitude).toBeCloseTo(38.8895);

      // Composite PK — inserting the same (uid, sourceId) again must fail.
      expect(() => db.prepare(`
        INSERT INTO atak_contacts (uid, sourceId, lastSeen, createdAt)
        VALUES ('EUD-001', 'source-a', @lastSeen, @createdAt)
      `).run({ lastSeen: now, createdAt: now })).toThrow();

      // A different sourceId with the same uid is allowed (per-source scope).
      expect(() => db.prepare(`
        INSERT INTO atak_contacts (uid, sourceId, lastSeen, createdAt)
        VALUES ('EUD-001', 'source-b', @lastSeen, @createdAt)
      `).run({ lastSeen: now, createdAt: now })).not.toThrow();

      db.close();
    });
  });

  describe('PostgreSQL', () => {
    it('creates the table and the two indexes with IF NOT EXISTS', async () => {
      const client = { query: vi.fn().mockResolvedValue({ rows: [] }) } as any;

      await runMigration127Postgres(client);

      expect(client.query).toHaveBeenCalledTimes(3);
      expect(client.query.mock.calls[0][0]).toContain('CREATE TABLE IF NOT EXISTS atak_contacts');
      expect(client.query.mock.calls[0][0]).toContain('PRIMARY KEY ("uid", "sourceId")');
      expect(client.query.mock.calls[1][0]).toContain('CREATE INDEX IF NOT EXISTS idx_atak_contacts_source_lastseen');
      expect(client.query.mock.calls[2][0]).toContain('CREATE INDEX IF NOT EXISTS idx_atak_contacts_source_node');
    });
  });

  describe('MySQL', () => {
    function makeConn(existRows: any[]) {
      return {
        query: vi.fn().mockResolvedValue([existRows, []]),
        release: vi.fn(),
      };
    }

    it('creates the table when absent, then skips create when present', async () => {
      // First run: table absent.
      const absentConn = makeConn([]);
      const absentPool = { getConnection: vi.fn().mockResolvedValue(absentConn) };

      await runMigration127Mysql(absentPool as any);

      expect(absentConn.query).toHaveBeenCalledTimes(2);
      expect(absentConn.query.mock.calls[1][0]).toContain('CREATE TABLE atak_contacts');
      expect(absentConn.query.mock.calls[1][0]).toContain('PRIMARY KEY (uid, sourceId)');
      expect(absentConn.release).toHaveBeenCalledTimes(1);

      // Second run: table present.
      const presentConn = makeConn([{ TABLE_NAME: 'atak_contacts' }]);
      const presentPool = { getConnection: vi.fn().mockResolvedValue(presentConn) };

      await runMigration127Mysql(presentPool as any);

      expect(presentConn.query).toHaveBeenCalledTimes(1); // only the existence check
      expect(presentConn.release).toHaveBeenCalledTimes(1);
    });
  });
});
