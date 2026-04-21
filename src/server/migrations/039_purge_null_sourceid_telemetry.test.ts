/**
 * Migration 039 — Purge NULL-sourceId telemetry
 *
 * Validates the SQLite migration deletes stranded rows (sourceId IS NULL),
 * preserves rows that carry a sourceId, and is idempotent on second run.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './039_purge_null_sourceid_telemetry.js';

function createTelemetryTable(db: Database.Database) {
  db.exec(`
    CREATE TABLE telemetry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nodeId TEXT NOT NULL,
      nodeNum INTEGER NOT NULL,
      telemetryType TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      value REAL NOT NULL,
      unit TEXT,
      createdAt INTEGER NOT NULL,
      packetTimestamp INTEGER,
      packetId INTEGER,
      channel INTEGER,
      precisionBits INTEGER,
      gpsAccuracy INTEGER,
      sourceId TEXT
    )
  `);
}

function insert(db: Database.Database, sourceId: string | null) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO telemetry (nodeId, nodeNum, telemetryType, timestamp, value, unit, createdAt, sourceId)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('!deadbeef', 0xdeadbeef, 'batteryLevel', now, 50, '%', now, sourceId);
}

describe('Migration 039 — purge NULL-sourceId telemetry', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    createTelemetryTable(db);
  });

  it('deletes rows with NULL sourceId', () => {
    insert(db, null);
    insert(db, null);
    insert(db, null);
    expect((db.prepare(`SELECT COUNT(*) c FROM telemetry`).get() as any).c).toBe(3);

    migration.up(db);

    expect((db.prepare(`SELECT COUNT(*) c FROM telemetry`).get() as any).c).toBe(0);
  });

  it('preserves rows with a non-NULL sourceId', () => {
    insert(db, 'source-A');
    insert(db, 'source-B');
    insert(db, null);

    migration.up(db);

    const rows = db.prepare(`SELECT sourceId FROM telemetry ORDER BY sourceId`).all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.sourceId)).toEqual(['source-A', 'source-B']);
  });

  it('is idempotent — running twice is a no-op after the first pass', () => {
    insert(db, null);
    insert(db, 'source-A');

    migration.up(db);
    migration.up(db);

    const rows = db.prepare(`SELECT sourceId FROM telemetry`).all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceId).toBe('source-A');
  });
});

/**
 * Regression for 4.0.0-beta7 bootloop: legacy v3.x databases carry
 * `telemetry.nodeNum REFERENCES nodes(nodeNum)`. After migration 029 swaps
 * nodes to a composite PK, that FK is structurally invalid and any DELETE
 * on telemetry with foreign_keys=ON raises "foreign key mismatch -
 * telemetry referencing nodes". 039 must tolerate this.
 */
describe('Migration 039 — legacy FK regression', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE nodes (
        nodeNum INTEGER NOT NULL,
        sourceId TEXT NOT NULL,
        PRIMARY KEY (nodeNum, sourceId)
      );
      CREATE TABLE telemetry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nodeId TEXT NOT NULL,
        nodeNum INTEGER NOT NULL,
        telemetryType TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        value REAL NOT NULL,
        unit TEXT,
        createdAt INTEGER NOT NULL,
        packetTimestamp INTEGER,
        packetId INTEGER,
        channel INTEGER,
        precisionBits INTEGER,
        gpsAccuracy REAL,
        sourceId TEXT,
        FOREIGN KEY (nodeNum) REFERENCES nodes(nodeNum)
      );
    `);
  });

  it('runs without raising "foreign key mismatch" even with legacy FK + composite PK', () => {
    // Seed with FKs off — the broken FK would block the INSERT itself otherwise.
    db.pragma('foreign_keys = OFF');
    insert(db, null);
    insert(db, 'source-A');
    db.pragma('foreign_keys = ON');

    expect(() => migration.up(db)).not.toThrow();

    const rows = db.prepare(`SELECT sourceId FROM telemetry`).all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceId).toBe('source-A');
  });

  it('restores foreign_keys=ON after running', () => {
    db.pragma('foreign_keys = OFF');
    insert(db, null);
    db.pragma('foreign_keys = ON');
    migration.up(db);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});
