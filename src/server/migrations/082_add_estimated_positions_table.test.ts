/**
 * Migration 082 — Add the global estimated_positions table and purge obsolete
 * per-source estimate telemetry rows (issue #3271).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './082_add_estimated_positions_table.js';

function createTelemetry(db: Database.Database) {
  db.exec(`
    CREATE TABLE telemetry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nodeId TEXT NOT NULL,
      nodeNum INTEGER NOT NULL,
      telemetryType TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      value REAL NOT NULL,
      unit TEXT,
      createdAt INTEGER
    );
  `);
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`
  ).get(name);
  return !!row;
}

describe('Migration 082 — add estimated_positions table (SQLite)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createTelemetry(db);
  });

  it('creates the estimated_positions table', () => {
    expect(tableExists(db, 'estimated_positions')).toBe(false);
    migration.up(db);
    expect(tableExists(db, 'estimated_positions')).toBe(true);
  });

  it('creates a table with the expected columns', () => {
    migration.up(db);
    const cols = db.prepare(`PRAGMA table_info(estimated_positions)`).all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(
      ['latitude', 'longitude', 'nodeId', 'nodeNum', 'observationCount', 'uncertaintyKm', 'updatedAt'].sort()
    );
  });

  it('purges obsolete estimate telemetry rows but keeps other telemetry', () => {
    const insert = db.prepare(
      `INSERT INTO telemetry (nodeId, nodeNum, telemetryType, timestamp, value) VALUES (?, ?, ?, ?, ?)`
    );
    insert.run('!aaaa0001', 1, 'estimated_latitude', 1000, 40.0);
    insert.run('!aaaa0001', 1, 'estimated_longitude', 1000, -100.0);
    insert.run('!aaaa0001', 1, 'battery', 1000, 95);
    insert.run('!aaaa0002', 2, 'temperature', 1000, 21.5);

    migration.up(db);

    const remaining = db.prepare(`SELECT telemetryType FROM telemetry ORDER BY telemetryType`).all() as Array<{ telemetryType: string }>;
    expect(remaining.map((r) => r.telemetryType)).toEqual(['battery', 'temperature']);
  });

  it('is idempotent — second run is a no-op', () => {
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();
    expect(tableExists(db, 'estimated_positions')).toBe(true);
  });

  it('allows insert + read of an estimate row', () => {
    migration.up(db);
    db.prepare(
      `INSERT INTO estimated_positions (nodeNum, nodeId, latitude, longitude, uncertaintyKm, observationCount, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(1, '!aaaa0001', 40.5, -100.5, 2.3, 7, 1234);
    const row = db.prepare(`SELECT * FROM estimated_positions WHERE nodeNum = 1`).get() as any;
    expect(row.latitude).toBeCloseTo(40.5);
    expect(row.observationCount).toBe(7);
    expect(row.uncertaintyKm).toBeCloseTo(2.3);
  });
});
