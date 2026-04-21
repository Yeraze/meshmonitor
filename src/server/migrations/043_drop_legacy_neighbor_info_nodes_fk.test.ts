/**
 * Migration 043 — Drop legacy neighbor_info→nodes(nodeNum) FKs
 *
 * Legacy v3.x SQLite databases carry `neighbor_info.nodeNum` and
 * `neighbor_info.neighborNodeNum` FKs REFERENCES nodes(nodeNum). After
 * migration 029 rebuilt nodes with a composite PK, those FKs are
 * structurally invalid — this was the root of the 4.0-beta8 migration 040
 * crash. This migration rebuilds neighbor_info without the FKs.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './043_drop_legacy_neighbor_info_nodes_fk.js';

function createLegacySchema(db: Database.Database) {
  db.exec(`
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
    CREATE INDEX idx_neighbor_info_node ON neighbor_info(nodeNum);
    CREATE INDEX idx_neighbor_info_timestamp ON neighbor_info(timestamp);
  `);
}

function createBaselineSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE nodes (
      nodeNum INTEGER NOT NULL,
      sourceId TEXT NOT NULL,
      PRIMARY KEY (nodeNum, sourceId)
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

function hasLegacyFk(db: Database.Database): boolean {
  const rows = db.prepare(`PRAGMA foreign_key_list(neighbor_info)`).all() as Array<{
    table: string;
    from: string;
    to: string;
  }>;
  return rows.some((r) => String(r.table).toLowerCase() === 'nodes');
}

function insertNeighbor(db: Database.Database, node: number, neighbor: number, sourceId: string | null) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO neighbor_info (nodeNum, neighborNodeNum, snr, lastRxTime, timestamp, createdAt, sourceId)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(node, neighbor, 5.5, now, now, now, sourceId);
}

describe('Migration 043 — drop legacy neighbor_info FK', () => {
  let db: Database.Database;

  describe('legacy schema with FK present', () => {
    beforeEach(() => {
      db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      createLegacySchema(db);
      db.pragma('foreign_keys = OFF');
      insertNeighbor(db, 100, 200, 'src-1');
      insertNeighbor(db, 300, 400, null);
      db.pragma('foreign_keys = ON');
    });

    it('removes the FKs from neighbor_info', () => {
      expect(hasLegacyFk(db)).toBe(true);
      migration.up(db);
      expect(hasLegacyFk(db)).toBe(false);
    });

    it('preserves all neighbor_info rows', () => {
      migration.up(db);
      const rows = db.prepare(`SELECT nodeNum, neighborNodeNum, sourceId FROM neighbor_info ORDER BY id`).all() as any[];
      expect(rows).toHaveLength(2);
      expect(rows[0].nodeNum).toBe(100);
      expect(rows[0].sourceId).toBe('src-1');
      expect(rows[1].nodeNum).toBe(300);
      expect(rows[1].sourceId).toBeNull();
    });

    it('recreates non-auto indexes', () => {
      migration.up(db);
      const idxs = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='neighbor_info' AND name NOT LIKE 'sqlite_autoindex_%'`)
        .all() as Array<{ name: string }>;
      const names = idxs.map((r) => r.name).sort();
      expect(names).toContain('idx_neighbor_info_node');
      expect(names).toContain('idx_neighbor_info_timestamp');
    });

    it('restores foreign_keys=ON after running', () => {
      migration.up(db);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    });

    it('allows DELETE on neighbor_info after the rebuild', () => {
      migration.up(db);
      expect(() => db.prepare(`DELETE FROM neighbor_info WHERE sourceId IS NULL`).run()).not.toThrow();
      const remaining = db.prepare(`SELECT COUNT(*) c FROM neighbor_info`).get() as any;
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
      insertNeighbor(db, 100, 200, 'src-1');
    });

    it('is a no-op when no legacy FK is present', () => {
      expect(hasLegacyFk(db)).toBe(false);
      migration.up(db);
      expect(hasLegacyFk(db)).toBe(false);
      const rows = db.prepare(`SELECT COUNT(*) c FROM neighbor_info`).get() as any;
      expect(rows.c).toBe(1);
    });
  });
});
