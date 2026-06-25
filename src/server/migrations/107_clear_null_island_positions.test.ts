/**
 * Migration 107 — Clear Null Island (0,0) node positions (SQLite, #3763).
 *
 * The PostgreSQL/MySQL paths run the same UPDATE with backend-quoted column
 * names and are exercised by integration tests; only the SQLite path is
 * covered here.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './107_clear_null_island_positions.js';

interface PosRow {
  id: string;
  latitude: number | null;
  longitude: number | null;
  latitudeOverride?: number | null;
}

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE nodes (
    id TEXT PRIMARY KEY,
    latitude REAL,
    longitude REAL,
    latitudeOverride REAL
  );`);
  db.exec(`CREATE TABLE meshcore_nodes (
    id TEXT PRIMARY KEY,
    latitude REAL,
    longitude REAL
  );`);
  db.exec(`CREATE TABLE telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nodeNum INTEGER NOT NULL,
    telemetryType TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    value REAL NOT NULL
  );`);
  return db;
}

/** Insert a paired position fix (a latitude row + a longitude row) into telemetry. */
function insertFix(
  db: Database.Database,
  nodeNum: number,
  timestamp: number,
  lat: number,
  lon: number,
): void {
  const stmt = db.prepare(
    'INSERT INTO telemetry (nodeNum, telemetryType, timestamp, value) VALUES (?, ?, ?, ?)',
  );
  stmt.run(nodeNum, 'latitude', timestamp, lat);
  stmt.run(nodeNum, 'longitude', timestamp, lon);
}

function telemetryRows(db: Database.Database): Array<{ telemetryType: string; value: number }> {
  return db
    .prepare('SELECT telemetryType, value FROM telemetry ORDER BY id')
    .all() as Array<{ telemetryType: string; value: number }>;
}

function getNode(db: Database.Database, table: string, id: string): PosRow {
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as PosRow;
}

describe('Migration 107 — clear Null Island positions (SQLite)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  it('nulls latitude/longitude for exact (0,0) and near-(0,0) rows', () => {
    db.prepare('INSERT INTO nodes (id, latitude, longitude) VALUES (?, ?, ?)').run('exact', 0, 0);
    db.prepare('INSERT INTO nodes (id, latitude, longitude) VALUES (?, ?, ?)').run('near', 0.0005, -0.0003);
    db.prepare('INSERT INTO meshcore_nodes (id, latitude, longitude) VALUES (?, ?, ?)').run('mc', 0, 0.000001);

    migration.up(db);

    expect(getNode(db, 'nodes', 'exact')).toMatchObject({ latitude: null, longitude: null });
    expect(getNode(db, 'nodes', 'near')).toMatchObject({ latitude: null, longitude: null });
    expect(getNode(db, 'meshcore_nodes', 'mc')).toMatchObject({ latitude: null, longitude: null });
  });

  it('preserves legitimate positions, including near-zero on a single axis', () => {
    db.prepare('INSERT INTO nodes (id, latitude, longitude) VALUES (?, ?, ?)').run('sf', 37.7749, -122.4194);
    // Greenwich: longitude ~0 but a real latitude — must NOT be cleared.
    db.prepare('INSERT INTO nodes (id, latitude, longitude) VALUES (?, ?, ?)').run('greenwich', 51.4778, 0.0001);

    migration.up(db);

    expect(getNode(db, 'nodes', 'sf')).toMatchObject({ latitude: 37.7749, longitude: -122.4194 });
    expect(getNode(db, 'nodes', 'greenwich')).toMatchObject({ latitude: 51.4778, longitude: 0.0001 });
  });

  it('leaves a manual latitudeOverride untouched', () => {
    db.prepare('INSERT INTO nodes (id, latitude, longitude, latitudeOverride) VALUES (?, ?, ?, ?)')
      .run('overridden', 0, 0, 12.34);

    migration.up(db);

    const row = getNode(db, 'nodes', 'overridden');
    expect(row.latitude).toBeNull();
    expect(row.latitudeOverride).toBe(12.34);
  });

  it('is idempotent — a second run is a no-op', () => {
    db.prepare('INSERT INTO nodes (id, latitude, longitude) VALUES (?, ?, ?)').run('exact', 0, 0);
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();
    expect(getNode(db, 'nodes', 'exact')).toMatchObject({ latitude: null, longitude: null });
  });

  describe('telemetry position-history cleanup', () => {
    it('deletes both rows of a (0,0) fix while keeping legitimate fixes', () => {
      insertFix(db, 1, 1000, 0, 0); // Null Island → both rows deleted
      insertFix(db, 1, 2000, 0.0004, -0.0002); // near-zero → both deleted
      insertFix(db, 2, 3000, 37.7749, -122.4194); // real → kept
      // Greenwich: lon ~0 but real lat — must be kept (not a pair of near-zeros).
      insertFix(db, 3, 4000, 51.4778, 0.0001);

      migration.up(db);

      const rows = telemetryRows(db);
      // Only the two legitimate fixes survive (2 rows each).
      expect(rows).toHaveLength(4);
      const lats = rows.filter((r) => r.telemetryType === 'latitude').map((r) => r.value);
      expect(lats.sort()).toEqual([37.7749, 51.4778]);
    });

    it('does not delete an unpaired near-zero latitude row', () => {
      // A lone latitude row with no matching longitude at the same (nodeNum,
      // timestamp) is not a Null Island fix and must be left untouched.
      db.prepare(
        'INSERT INTO telemetry (nodeNum, telemetryType, timestamp, value) VALUES (?, ?, ?, ?)',
      ).run(1, 'latitude', 5000, 0);

      migration.up(db);

      expect(telemetryRows(db)).toHaveLength(1);
    });

    it('is idempotent for telemetry — a second run deletes nothing more', () => {
      insertFix(db, 1, 1000, 0, 0);
      insertFix(db, 2, 2000, 10, 20);
      migration.up(db);
      const after = telemetryRows(db);
      migration.up(db);
      expect(telemetryRows(db)).toEqual(after);
    });
  });
});
