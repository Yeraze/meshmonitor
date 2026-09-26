/**
 * Tests for migration 175 — likely-aircraft classification columns on
 * `nodes` (#5364/#5365 Phase 1 WP1).
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migration } from './175_add_node_aircraft_classification.js';

/** The table as migration 174 leaves it — no aircraft-classification columns. */
function createParentTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      nodeNum INTEGER NOT NULL,
      nodeId TEXT NOT NULL,
      longName TEXT,
      shortName TEXT,
      altitude REAL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      sourceId TEXT NOT NULL DEFAULT 'default',
      PRIMARY KEY (nodeNum, sourceId)
    )
  `);
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

describe('Migration 175 — nodes aircraft-classification columns', () => {
  it('adds all five columns and is idempotent (second up() does not throw)', () => {
    const db = new Database(':memory:');
    createParentTable(db);

    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();

    const cols = columnNames(db, 'nodes');
    expect(cols).toContain('likelyAircraft');
    expect(cols).toContain('aircraftBasis');
    expect(cols).toContain('groundElevation');
    expect(cols).toContain('heightAboveGround');
    expect(cols).toContain('aircraftClassifiedAt');

    db.close();
  });

  it('existing rows read null for the new columns, and a classification write round-trips', () => {
    const db = new Database(':memory:');
    createParentTable(db);
    db.prepare(`
      INSERT INTO nodes (nodeNum, nodeId, longName, shortName, altitude, createdAt, updatedAt, sourceId)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(100, '!00000064', 'Node 100', 'N100', 3200, 1000, 1000, 'default');

    migration.up(db);

    const before = db.prepare(
      'SELECT likelyAircraft, aircraftBasis, groundElevation, heightAboveGround, aircraftClassifiedAt FROM nodes WHERE nodeNum = 100',
    ).get() as Record<string, unknown>;
    expect(before.likelyAircraft).toBeNull();
    expect(before.aircraftBasis).toBeNull();
    expect(before.groundElevation).toBeNull();
    expect(before.heightAboveGround).toBeNull();
    expect(before.aircraftClassifiedAt).toBeNull();

    const now = Date.now();
    db.prepare(`
      UPDATE nodes
      SET likelyAircraft = 1, aircraftBasis = 'agl', groundElevation = 200, heightAboveGround = 3000, aircraftClassifiedAt = ?
      WHERE nodeNum = 100
    `).run(now);

    const after = db.prepare(
      'SELECT likelyAircraft, aircraftBasis, groundElevation, heightAboveGround, aircraftClassifiedAt FROM nodes WHERE nodeNum = 100',
    ).get() as Record<string, unknown>;
    expect(after.likelyAircraft).toBe(1);
    expect(after.aircraftBasis).toBe('agl');
    expect(after.groundElevation).toBe(200);
    expect(after.heightAboveGround).toBe(3000);
    expect(after.aircraftClassifiedAt).toBe(now);

    db.close();
  });
});
