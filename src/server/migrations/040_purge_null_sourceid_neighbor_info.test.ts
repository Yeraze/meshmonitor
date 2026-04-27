/**
 * Migration 040 — Reassign NULL-sourceId neighbor_info to the default source
 *
 * Validates that legacy v3.x neighbor_info rows (sourceId IS NULL) are
 * migrated onto the user's default source instead of being purged. Earlier
 * versions of this migration deleted those rows, silently wiping neighbor
 * history on the v3.x → v4.0 upgrade.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './040_purge_null_sourceid_neighbor_info.js';

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
    CREATE TABLE neighbor_info (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nodeNum INTEGER NOT NULL,
      neighborNodeNum INTEGER NOT NULL,
      snr REAL,
      lastRxTime INTEGER,
      timestamp INTEGER NOT NULL,
      createdAt INTEGER NOT NULL,
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

function insertNeighbor(db: Database.Database, sourceId: string | null) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO neighbor_info (nodeNum, neighborNodeNum, snr, lastRxTime, timestamp, createdAt, sourceId)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(0xdeadbeef, 0xcafebabe, 5.5, now, now, now, sourceId);
}

describe('Migration 040 — reassign NULL-sourceId neighbor_info', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
  });

  it('reassigns NULL rows to the existing default (oldest) source', () => {
    insertSource(db, 'src-old', 1000);
    insertSource(db, 'src-new', 2000);
    insertNeighbor(db, null);
    insertNeighbor(db, null);
    insertNeighbor(db, null);

    migration.up(db);

    const rows = db.prepare(`SELECT sourceId FROM neighbor_info`).all() as any[];
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.sourceId).toBe('src-old');
    }
  });

  it('preserves rows that already carry a sourceId', () => {
    insertSource(db, 'src-old', 1000);
    insertNeighbor(db, 'source-A');
    insertNeighbor(db, 'source-B');
    insertNeighbor(db, null);

    migration.up(db);

    const rows = db.prepare(`SELECT sourceId FROM neighbor_info ORDER BY id`).all() as any[];
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.sourceId)).toEqual(['source-A', 'source-B', 'src-old']);
  });

  it('synthesizes a default source when sources table is empty', () => {
    insertNeighbor(db, null);
    insertNeighbor(db, null);

    migration.up(db);

    const sources = db.prepare(`SELECT id FROM sources`).all() as any[];
    expect(sources).toHaveLength(1);
    const synthId = sources[0].id;

    const rows = db.prepare(`SELECT sourceId FROM neighbor_info`).all() as any[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.sourceId).toBe(synthId);
    }
  });

  it('is idempotent — running twice is a no-op after the first pass', () => {
    insertSource(db, 'src-old', 1000);
    insertNeighbor(db, null);
    insertNeighbor(db, 'source-A');

    migration.up(db);
    migration.up(db);

    const rows = db.prepare(`SELECT sourceId FROM neighbor_info ORDER BY id`).all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.sourceId)).toEqual(['src-old', 'source-A']);
  });

  it('succeeds on legacy schema: neighbor_info FK to nodes(nodeNum) + composite nodes PK', () => {
    // Reproduces the 4.0-beta8 upgrade failure:
    //   - Pre-029: nodes PK was (nodeNum); neighbor_info.nodeNum FK → nodes(nodeNum)
    //   - Migration 029 rebuilt nodes with composite PK (nodeNum, sourceId)
    //   - neighbor_info FK is now structurally invalid (nodeNum alone not unique)
    //   - With foreign_keys=ON, any write raises "foreign key mismatch"
    const legacyDb = new Database(':memory:');
    try {
      legacyDb.pragma('foreign_keys = OFF');
      legacyDb.exec(`
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
        CREATE TABLE neighbor_info (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          nodeNum INTEGER NOT NULL REFERENCES nodes(nodeNum) ON DELETE CASCADE,
          neighborNodeNum INTEGER NOT NULL REFERENCES nodes(nodeNum) ON DELETE CASCADE,
          snr REAL,
          lastRxTime INTEGER,
          timestamp INTEGER NOT NULL,
          createdAt INTEGER NOT NULL,
          sourceId TEXT
        );
      `);
      insertSource(legacyDb, 'src-old', 1000);
      const now = Date.now();
      legacyDb
        .prepare(
          `INSERT INTO neighbor_info (nodeNum, neighborNodeNum, snr, lastRxTime, timestamp, createdAt, sourceId)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(1, 2, 5.5, now, now, now, null);

      legacyDb.pragma('foreign_keys = ON');

      expect(() => migration.up(legacyDb)).not.toThrow();

      const rows = legacyDb.prepare(`SELECT sourceId FROM neighbor_info`).all() as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].sourceId).toBe('src-old');
      expect(legacyDb.pragma('foreign_keys', { simple: true })).toBe(1);
    } finally {
      legacyDb.close();
    }
  });
});
