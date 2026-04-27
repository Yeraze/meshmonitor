/**
 * Migration 039 — Reassign NULL-sourceId telemetry to the default source
 *
 * Validates that legacy v3.x telemetry rows (sourceId IS NULL) are migrated
 * onto the user's default source instead of being purged. Earlier versions
 * of this migration deleted those rows, silently wiping telemetry history
 * on the v3.x → v4.0 upgrade.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './039_purge_null_sourceid_telemetry.js';

function createSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      config TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      createdBy INTEGER
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
      gpsAccuracy INTEGER,
      sourceId TEXT
    );
  `);
}

function insertSource(db: Database.Database, id: string, createdAt: number) {
  db.prepare(`
    INSERT INTO sources (id, name, type, config, enabled, createdAt, updatedAt)
    VALUES (?, ?, 'meshtastic_tcp', '{}', 1, ?, ?)
  `).run(id, `Source ${id}`, createdAt, createdAt);
}

function insertTelemetry(db: Database.Database, sourceId: string | null) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO telemetry (nodeId, nodeNum, telemetryType, timestamp, value, unit, createdAt, sourceId)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('!deadbeef', 0xdeadbeef, 'batteryLevel', now, 50, '%', now, sourceId);
}

describe('Migration 039 — reassign NULL-sourceId telemetry', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
  });

  it('reassigns NULL rows to the existing default (oldest) source', () => {
    insertSource(db, 'src-old', 1000);
    insertSource(db, 'src-new', 2000);
    insertTelemetry(db, null);
    insertTelemetry(db, null);
    insertTelemetry(db, null);

    migration.up(db);

    const rows = db.prepare(`SELECT sourceId FROM telemetry`).all() as any[];
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.sourceId).toBe('src-old');
    }
  });

  it('preserves rows that already carry a sourceId', () => {
    insertSource(db, 'src-old', 1000);
    insertTelemetry(db, 'source-A');
    insertTelemetry(db, 'source-B');
    insertTelemetry(db, null);

    migration.up(db);

    const rows = db.prepare(`SELECT sourceId FROM telemetry ORDER BY id`).all() as any[];
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.sourceId)).toEqual(['source-A', 'source-B', 'src-old']);
  });

  it('synthesizes a default source when sources table is empty', () => {
    insertTelemetry(db, null);
    insertTelemetry(db, null);

    migration.up(db);

    const sources = db.prepare(`SELECT id FROM sources`).all() as any[];
    expect(sources).toHaveLength(1);
    const synthId = sources[0].id;

    const telemetry = db.prepare(`SELECT sourceId FROM telemetry`).all() as any[];
    expect(telemetry).toHaveLength(2);
    for (const row of telemetry) {
      expect(row.sourceId).toBe(synthId);
    }
  });

  it('is idempotent — running twice is a no-op after the first pass', () => {
    insertSource(db, 'src-old', 1000);
    insertTelemetry(db, null);
    insertTelemetry(db, 'source-A');

    migration.up(db);
    const sourcesAfterFirst = db.prepare(`SELECT id FROM sources ORDER BY createdAt`).all() as any[];

    migration.up(db);
    const sourcesAfterSecond = db.prepare(`SELECT id FROM sources ORDER BY createdAt`).all() as any[];

    expect(sourcesAfterSecond).toEqual(sourcesAfterFirst);
    const rows = db.prepare(`SELECT sourceId FROM telemetry ORDER BY id`).all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.sourceId)).toEqual(['src-old', 'source-A']);
  });

  it('skips when sources table does not yet exist', () => {
    const bareDb = new Database(':memory:');
    try {
      bareDb.exec(`
        CREATE TABLE telemetry (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          nodeId TEXT NOT NULL,
          nodeNum INTEGER NOT NULL,
          telemetryType TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          value REAL NOT NULL,
          unit TEXT,
          createdAt INTEGER NOT NULL,
          sourceId TEXT
        );
      `);
      insertTelemetry(bareDb, null);

      expect(() => migration.up(bareDb)).not.toThrow();

      const rows = bareDb.prepare(`SELECT sourceId FROM telemetry`).all() as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].sourceId).toBeNull();
    } finally {
      bareDb.close();
    }
  });
});

/**
 * Regression for 4.0.0-beta7 bootloop: legacy v3.x databases carry
 * `telemetry.nodeNum REFERENCES nodes(nodeNum)`. After migration 029 swaps
 * nodes to a composite PK, that FK is structurally invalid and any write
 * on telemetry with foreign_keys=ON raises "foreign key mismatch -
 * telemetry referencing nodes". 039 must tolerate this.
 */
describe('Migration 039 — legacy FK regression', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        config TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        createdBy INTEGER
      );
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
    insertSource(db, 'src-old', 1000);
  });

  it('runs without raising "foreign key mismatch" even with legacy FK + composite PK', () => {
    db.pragma('foreign_keys = OFF');
    insertTelemetry(db, null);
    insertTelemetry(db, 'source-A');
    db.pragma('foreign_keys = ON');

    expect(() => migration.up(db)).not.toThrow();

    const rows = db.prepare(`SELECT sourceId FROM telemetry ORDER BY id`).all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.sourceId)).toEqual(['src-old', 'source-A']);
  });

  it('restores foreign_keys=ON after running', () => {
    db.pragma('foreign_keys = OFF');
    insertTelemetry(db, null);
    db.pragma('foreign_keys = ON');
    migration.up(db);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});
