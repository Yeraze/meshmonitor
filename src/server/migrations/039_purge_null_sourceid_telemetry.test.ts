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
