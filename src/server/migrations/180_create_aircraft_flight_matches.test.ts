/**
 * Migration 180 tests — aircraft_flight_matches (#5374).
 */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { migration, runMigration180Postgres, runMigration180Mysql } from './180_create_aircraft_flight_matches.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE sources (id TEXT PRIMARY KEY)`);
  db.exec(`INSERT INTO sources (id) VALUES ('src-a'), ('src-b')`);
  return db;
}

describe('Migration 180 — aircraft_flight_matches', () => {
  describe('SQLite', () => {
    it('creates the table and is idempotent', () => {
      const db = freshDb();
      migration.up(db);
      expect(() => migration.up(db)).not.toThrow();
      const cols = (db.prepare(`PRAGMA table_info(aircraft_flight_matches)`).all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols).toEqual(expect.arrayContaining([
        'sourceId', 'nodeNum', 'episodeStartedAt', 'lookups', 'firstLookupAt', 'status', 'feed', 'hex',
        'callsign', 'aircraftType', 'registration', 'gsKt', 'trackDeg', 'altM', 'distanceKm', 'matchedAt',
      ]));
      db.close();
    });

    it('defaults lookups to 0 and status to none, and enforces the (sourceId, nodeNum) PK', () => {
      const db = freshDb();
      migration.up(db);
      const insert = db.prepare(`INSERT INTO aircraft_flight_matches (sourceId, nodeNum, episodeStartedAt) VALUES (?, ?, ?)`);
      insert.run('src-a', 4294967295, 1000);
      insert.run('src-b', 4294967295, 1000);
      expect(() => insert.run('src-a', 4294967295, 2000)).toThrow();
      const row = db.prepare(`SELECT * FROM aircraft_flight_matches WHERE sourceId = 'src-a'`).get() as any;
      expect(row.lookups).toBe(0);
      expect(row.status).toBe('none');
      expect(row.nodeNum).toBe(4294967295);
      db.close();
    });

    it('cascades a source delete', () => {
      const db = freshDb();
      migration.up(db);
      db.prepare(`INSERT INTO aircraft_flight_matches (sourceId, nodeNum, episodeStartedAt) VALUES ('src-a', 1, 1)`).run();
      db.prepare(`DELETE FROM sources WHERE id = 'src-a'`).run();
      expect((db.prepare(`SELECT COUNT(*) AS c FROM aircraft_flight_matches`).get() as { c: number }).c).toBe(0);
      db.close();
    });
  });

  describe('PostgreSQL (DDL shape)', () => {
    it('uses BIGINT nodeNum and a cascading FK', async () => {
      const client = { query: vi.fn().mockResolvedValue(undefined) };
      await runMigration180Postgres(client as any);
      const sql = client.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS aircraft_flight_matches/);
      expect(sql).toMatch(/"nodeNum" BIGINT NOT NULL/);
      expect(sql).toMatch(/REFERENCES sources\(id\) ON DELETE CASCADE/);
      expect(sql).toMatch(/PRIMARY KEY \("sourceId", "nodeNum"\)/);
    });
  });

  describe('MySQL (DDL shape)', () => {
    function makeConn(existRows: any[]) {
      return { query: vi.fn().mockResolvedValue([existRows, []]), release: vi.fn() };
    }

    it('creates the table when missing', async () => {
      const conn = makeConn([]);
      await runMigration180Mysql({ getConnection: vi.fn().mockResolvedValue(conn) } as any);
      const ddl = conn.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(ddl).toMatch(/CREATE TABLE aircraft_flight_matches/);
      expect(ddl).toMatch(/nodeNum BIGINT NOT NULL/);
      expect(ddl).toMatch(/FOREIGN KEY \(sourceId\) REFERENCES sources\(id\) ON DELETE CASCADE/);
    });

    it('skips create when the table exists', async () => {
      const conn = makeConn([{ TABLE_NAME: 'aircraft_flight_matches' }]);
      await runMigration180Mysql({ getConnection: vi.fn().mockResolvedValue(conn) } as any);
      const ddl = conn.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(ddl).not.toMatch(/CREATE TABLE/);
      expect(conn.release).toHaveBeenCalled();
    });
  });
});
