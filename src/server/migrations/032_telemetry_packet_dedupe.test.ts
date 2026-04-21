/**
 * Migration 032 — telemetry packet dedupe
 *
 * Regression for 4.0.0-beta7 bootloop: legacy v3.x databases carry
 * `telemetry.nodeNum REFERENCES nodes(nodeNum)`. After migration 029 swapped
 * nodes to a composite PK (nodeNum, sourceId), that FK is structurally
 * invalid — any DELETE on telemetry with foreign_keys=ON raises
 * "foreign key mismatch - telemetry referencing nodes". 032 is the first
 * post-029 migration to DELETE from telemetry, so it was the first to crash.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './032_telemetry_packet_dedupe.js';

function createTelemetryTable(db: Database.Database, withLegacyFk: boolean) {
  if (withLegacyFk) {
    db.exec(`
      CREATE TABLE nodes (
        nodeNum INTEGER NOT NULL,
        sourceId TEXT NOT NULL,
        PRIMARY KEY (nodeNum, sourceId)
      );
    `);
  }
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
      gpsAccuracy REAL,
      sourceId TEXT
      ${withLegacyFk ? ', FOREIGN KEY (nodeNum) REFERENCES nodes(nodeNum)' : ''}
    )
  `);
}

function insertRow(
  db: Database.Database,
  opts: { sourceId: string | null; nodeNum: number; packetId: number | null; telemetryType: string },
) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO telemetry (nodeId, nodeNum, telemetryType, timestamp, value, unit, createdAt, packetId, sourceId)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `!${opts.nodeNum.toString(16).padStart(8, '0')}`,
    opts.nodeNum,
    opts.telemetryType,
    now,
    42,
    '%',
    now,
    opts.packetId,
    opts.sourceId,
  );
}

describe('Migration 032 — telemetry packet dedupe', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    createTelemetryTable(db, false);
  });

  it('dedupes rows with the same (sourceId, nodeNum, packetId, telemetryType)', () => {
    insertRow(db, { sourceId: 'src-1', nodeNum: 1, packetId: 100, telemetryType: 'batteryLevel' });
    insertRow(db, { sourceId: 'src-1', nodeNum: 1, packetId: 100, telemetryType: 'batteryLevel' });
    insertRow(db, { sourceId: 'src-1', nodeNum: 1, packetId: 100, telemetryType: 'voltage' });

    migration.up(db);

    const rows = db.prepare(`SELECT * FROM telemetry ORDER BY id`).all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.telemetryType).sort()).toEqual(['batteryLevel', 'voltage']);
  });

  it('keeps NULL-packetId rows intact', () => {
    insertRow(db, { sourceId: 'src-1', nodeNum: 1, packetId: null, telemetryType: 'batteryLevel' });
    insertRow(db, { sourceId: 'src-1', nodeNum: 1, packetId: null, telemetryType: 'batteryLevel' });

    migration.up(db);

    const rows = db.prepare(`SELECT * FROM telemetry`).all() as any[];
    expect(rows).toHaveLength(2);
  });

  it('creates the partial unique index', () => {
    migration.up(db);
    const idx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='telemetry_source_packet_type_uniq'`)
      .get();
    expect(idx).toBeTruthy();
  });

  it('is idempotent — second run is a no-op', () => {
    insertRow(db, { sourceId: 'src-1', nodeNum: 1, packetId: 100, telemetryType: 'batteryLevel' });
    insertRow(db, { sourceId: 'src-1', nodeNum: 1, packetId: 100, telemetryType: 'batteryLevel' });

    migration.up(db);
    migration.up(db);

    const rows = db.prepare(`SELECT * FROM telemetry`).all() as any[];
    expect(rows).toHaveLength(1);
  });
});

describe('Migration 032 — legacy FK regression', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createTelemetryTable(db, true);
  });

  it('runs without raising "foreign key mismatch" when telemetry has legacy FK to nodes(nodeNum)', () => {
    // Seed with FKs off — the broken FK would block the INSERT itself otherwise.
    db.pragma('foreign_keys = OFF');
    insertRow(db, { sourceId: 'src-1', nodeNum: 1, packetId: 100, telemetryType: 'batteryLevel' });
    insertRow(db, { sourceId: 'src-1', nodeNum: 1, packetId: 100, telemetryType: 'batteryLevel' });
    db.pragma('foreign_keys = ON');

    expect(() => migration.up(db)).not.toThrow();

    const rows = db.prepare(`SELECT * FROM telemetry`).all() as any[];
    expect(rows).toHaveLength(1);
  });

  it('restores foreign_keys=ON after running', () => {
    db.pragma('foreign_keys = OFF');
    insertRow(db, { sourceId: 'src-1', nodeNum: 1, packetId: 100, telemetryType: 'batteryLevel' });
    db.pragma('foreign_keys = ON');
    migration.up(db);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});
