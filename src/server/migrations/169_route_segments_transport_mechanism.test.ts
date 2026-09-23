/**
 * Tests for migration 169 — `route_segments.transportMechanism` column and
 * its (sourceId, transportMechanism, distanceKm) index (#5101).
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migration } from './169_route_segments_transport_mechanism.js';

/** `route_segments` as it stood before migration 169. */
function createParentTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS route_segments (
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
      sourceId TEXT
    )
  `);
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

function indexNames(db: Database.Database): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='route_segments'`).all() as Array<{ name: string }>)
    .map((r) => r.name);
}

describe('Migration 169 — route_segments.transportMechanism (SQLite)', () => {
  it('adds the column and index, and is idempotent (second up() does not throw)', () => {
    const db = new Database(':memory:');
    createParentTable(db);

    expect(columnNames(db, 'route_segments')).not.toContain('transportMechanism');

    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();

    expect(columnNames(db, 'route_segments')).toContain('transportMechanism');
    expect(indexNames(db)).toContain('idx_route_segments_source_transport_distance');

    db.close();
  });

  it('an existing row reads NULL for the new column', () => {
    const db = new Database(':memory:');
    createParentTable(db);
    db.prepare(`
      INSERT INTO route_segments (fromNodeNum, toNodeNum, fromNodeId, toNodeId, distanceKm, timestamp, createdAt, sourceId)
      VALUES (1, 2, '!00000001', '!00000002', 12.5, 1000, 1000, 'src-a')
    `).run();

    migration.up(db);

    const row = db.prepare(`SELECT * FROM route_segments WHERE fromNodeNum = 1`).get() as Record<string, unknown>;
    expect(row.transportMechanism).toBeNull();

    db.close();
  });
});
