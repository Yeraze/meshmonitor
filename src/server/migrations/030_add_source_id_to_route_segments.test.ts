/**
 * Migration 030 — route_segments sourceId
 *
 * Regression for discussion #2619: legacy SQLite databases carry
 * `route_segments.fromNodeNum/toNodeNum REFERENCES nodes(nodeNum)` FKs from
 * pre-baseline schemas. After migration 029 rebuilds nodes with a composite
 * PK (nodeNum, sourceId), the nodeNum column alone is no longer unique, so
 * SQLite's ALTER TABLE compatibility check raises "foreign key mismatch —
 * route_segments referencing nodes" the moment 030 tries to add a column.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './030_add_source_id_to_route_segments.js';

function createPost029Schema(db: Database.Database) {
  db.exec(`
    CREATE TABLE nodes (
      nodeNum INTEGER NOT NULL,
      nodeId TEXT NOT NULL,
      sourceId TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      PRIMARY KEY (nodeNum, sourceId),
      UNIQUE (nodeId, sourceId)
    );

    -- Legacy FK to nodes(nodeNum) carried over from pre-baseline schema.
    CREATE TABLE route_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fromNodeNum INTEGER NOT NULL,
      toNodeNum INTEGER NOT NULL,
      fromNodeId TEXT NOT NULL,
      toNodeId TEXT NOT NULL,
      distanceKm REAL NOT NULL,
      isRecordHolder INTEGER DEFAULT 0,
      fromLatitude REAL,
      fromLongitude REAL,
      toLatitude REAL,
      toLongitude REAL,
      timestamp INTEGER NOT NULL,
      createdAt INTEGER NOT NULL,
      FOREIGN KEY (fromNodeNum) REFERENCES nodes(nodeNum),
      FOREIGN KEY (toNodeNum) REFERENCES nodes(nodeNum)
    );

    CREATE TABLE traceroutes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fromNodeNum INTEGER NOT NULL,
      toNodeNum INTEGER NOT NULL,
      route TEXT,
      routePositions TEXT,
      timestamp INTEGER NOT NULL,
      sourceId TEXT
    );
  `);
}

describe('Migration 030 — route_segments sourceId', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createPost029Schema(db);
  });

  it('adds sourceId and rebuilds from traceroutes with legacy FK to nodes(nodeNum)', () => {
    // Seed nodes (composite PK) + one traceroute with a position snapshot.
    const now = Date.now();
    db.prepare(
      `INSERT INTO nodes (nodeNum, nodeId, sourceId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)`,
    ).run(100, '!00000064', 'src-1', now, now);
    db.prepare(
      `INSERT INTO nodes (nodeNum, nodeId, sourceId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)`,
    ).run(200, '!000000c8', 'src-1', now, now);

    const positions = JSON.stringify({
      '100': { lat: 47.0, lng: 8.0 },
      '200': { lat: 47.1, lng: 8.1 },
    });
    db.prepare(
      `INSERT INTO traceroutes (fromNodeNum, toNodeNum, route, routePositions, timestamp, sourceId)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(200, 100, '[]', positions, now, 'src-1');

    // One legacy row — will be cleared by the migration.
    db.pragma('foreign_keys = OFF');
    db.prepare(
      `INSERT INTO route_segments
       (fromNodeNum, toNodeNum, fromNodeId, toNodeId, distanceKm, timestamp, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(100, 200, '!00000064', '!000000c8', 12.3, now, now);
    db.pragma('foreign_keys = ON');

    expect(() => migration.up(db)).not.toThrow();

    const cols = db.prepare(`PRAGMA table_info(route_segments)`).all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'sourceId')).toBe(true);

    // Rebuild should have re-emitted one segment per consecutive hop pair.
    const rebuilt = db
      .prepare(`SELECT fromNodeNum, toNodeNum, sourceId FROM route_segments`)
      .all() as Array<{ fromNodeNum: number; toNodeNum: number; sourceId: string | null }>;
    expect(rebuilt.length).toBe(1);
    expect(rebuilt[0].sourceId).toBe('src-1');
  });

  it('restores foreign_keys pragma after the rebuild completes', () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO nodes (nodeNum, nodeId, sourceId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)`,
    ).run(100, '!00000064', 'src-1', now, now);

    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    migration.up(db);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('is idempotent when the column already exists', () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO nodes (nodeNum, nodeId, sourceId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)`,
    ).run(100, '!00000064', 'src-1', now, now);

    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();

    const cols = db.prepare(`PRAGMA table_info(route_segments)`).all() as Array<{ name: string }>;
    expect(cols.filter((c) => c.name === 'sourceId').length).toBe(1);
  });
});
