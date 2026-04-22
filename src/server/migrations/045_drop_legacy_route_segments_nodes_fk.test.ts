/**
 * Migration 045 — Drop legacy route_segments→nodes(nodeNum) FKs
 *
 * Legacy v3.x SQLite databases carry `route_segments.fromNodeNum` and
 * `route_segments.toNodeNum` FKs REFERENCES nodes(nodeNum). After migration
 * 029 rebuilt nodes with a composite PK, those FKs are structurally invalid.
 * This migration rebuilds route_segments without the FKs.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './045_drop_legacy_route_segments_nodes_fk.js';

function createLegacySchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE nodes (
      nodeNum INTEGER NOT NULL,
      sourceId TEXT NOT NULL,
      PRIMARY KEY (nodeNum, sourceId)
    );
    CREATE TABLE route_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fromNodeNum INTEGER NOT NULL REFERENCES nodes(nodeNum) ON DELETE CASCADE,
      toNodeNum INTEGER NOT NULL REFERENCES nodes(nodeNum) ON DELETE CASCADE,
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
    );
    CREATE INDEX idx_route_segments_from_to ON route_segments(fromNodeNum, toNodeNum);
    CREATE INDEX idx_route_segments_source_id ON route_segments(sourceId);
    CREATE INDEX idx_route_segments_distance ON route_segments(distanceKm DESC);
  `);
}

function createBaselineSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE nodes (
      nodeNum INTEGER NOT NULL,
      sourceId TEXT NOT NULL,
      PRIMARY KEY (nodeNum, sourceId)
    );
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
      sourceId TEXT
    );
  `);
}

function hasLegacyFk(db: Database.Database): boolean {
  const rows = db.prepare(`PRAGMA foreign_key_list(route_segments)`).all() as Array<{
    table: string;
    from: string;
    to: string;
  }>;
  return rows.some((r) => String(r.table).toLowerCase() === 'nodes');
}

function insertSegment(db: Database.Database, from: number, to: number, sourceId: string | null) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO route_segments
      (fromNodeNum, toNodeNum, fromNodeId, toNodeId, distanceKm, isRecordHolder,
       fromLatitude, fromLongitude, toLatitude, toLongitude, timestamp, createdAt, sourceId)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    from, to,
    `!${from.toString(16)}`, `!${to.toString(16)}`,
    12.5,
    10.1, 20.2, 10.3, 20.4,
    now, now, sourceId,
  );
}

describe('Migration 045 — drop legacy route_segments FK', () => {
  let db: Database.Database;

  describe('legacy schema with FK present', () => {
    beforeEach(() => {
      db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      createLegacySchema(db);
      // Insert parent nodes so legacy FK inserts succeed under FK enforcement.
      db.prepare(`INSERT INTO nodes (nodeNum, sourceId) VALUES (?, ?)`).run(100, 'src-1');
      db.prepare(`INSERT INTO nodes (nodeNum, sourceId) VALUES (?, ?)`).run(200, 'src-1');
      db.prepare(`INSERT INTO nodes (nodeNum, sourceId) VALUES (?, ?)`).run(300, 'src-1');
      db.prepare(`INSERT INTO nodes (nodeNum, sourceId) VALUES (?, ?)`).run(400, 'src-1');
      // Legacy FK is structurally broken (refs non-unique col), so any INSERT
      // fails with "foreign key mismatch" when FKs are on. Turn off for seed.
      db.pragma('foreign_keys = OFF');
      insertSegment(db, 100, 200, 'src-1');
      insertSegment(db, 300, 400, null);
      db.pragma('foreign_keys = ON');
    });

    it('removes the FKs from route_segments', () => {
      expect(hasLegacyFk(db)).toBe(true);
      migration.up(db);
      expect(hasLegacyFk(db)).toBe(false);
    });

    it('preserves all route_segments rows', () => {
      migration.up(db);
      const rows = db.prepare(
        `SELECT fromNodeNum, toNodeNum, sourceId, distanceKm FROM route_segments ORDER BY id`
      ).all() as any[];
      expect(rows).toHaveLength(2);
      expect(rows[0].fromNodeNum).toBe(100);
      expect(rows[0].toNodeNum).toBe(200);
      expect(rows[0].sourceId).toBe('src-1');
      expect(rows[0].distanceKm).toBe(12.5);
      expect(rows[1].fromNodeNum).toBe(300);
      expect(rows[1].sourceId).toBeNull();
    });

    it('recreates non-auto indexes', () => {
      migration.up(db);
      const idxs = db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type='index' AND tbl_name='route_segments'
             AND name NOT LIKE 'sqlite_autoindex_%'`,
        )
        .all() as Array<{ name: string }>;
      const names = idxs.map((r) => r.name).sort();
      expect(names).toContain('idx_route_segments_from_to');
      expect(names).toContain('idx_route_segments_source_id');
      expect(names).toContain('idx_route_segments_distance');
    });

    it('restores foreign_keys=ON after running', () => {
      migration.up(db);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    });

    it('allows DELETE on route_segments after the rebuild', () => {
      migration.up(db);
      expect(() =>
        db.prepare(`DELETE FROM route_segments WHERE sourceId IS NULL`).run()
      ).not.toThrow();
      const remaining = db.prepare(`SELECT COUNT(*) c FROM route_segments`).get() as any;
      expect(remaining.c).toBe(1);
    });

    it('allows DELETE by fromNodeNum/toNodeNum (node purge path)', () => {
      migration.up(db);
      expect(() =>
        db.prepare(
          `DELETE FROM route_segments WHERE fromNodeNum = ? OR toNodeNum = ?`
        ).run(100, 100)
      ).not.toThrow();
      const remaining = db.prepare(`SELECT COUNT(*) c FROM route_segments`).get() as any;
      expect(remaining.c).toBe(1);
    });

    it('is idempotent — second run is a no-op', () => {
      migration.up(db);
      expect(() => migration.up(db)).not.toThrow();
      expect(hasLegacyFk(db)).toBe(false);
    });
  });

  describe('baseline schema without FK', () => {
    beforeEach(() => {
      db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      createBaselineSchema(db);
      insertSegment(db, 100, 200, 'src-1');
    });

    it('is a no-op when no legacy FK is present', () => {
      expect(hasLegacyFk(db)).toBe(false);
      migration.up(db);
      expect(hasLegacyFk(db)).toBe(false);
      const rows = db.prepare(`SELECT COUNT(*) c FROM route_segments`).get() as any;
      expect(rows.c).toBe(1);
    });
  });
});
