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
  return db;
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
});
