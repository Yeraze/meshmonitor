/**
 * Migration 044 — Drop legacy traceroutes→nodes(nodeNum) FKs
 *
 * Legacy v3.x SQLite databases carry `traceroutes.fromNodeNum` and
 * `traceroutes.toNodeNum` FKs REFERENCES nodes(nodeNum). After migration 029
 * rebuilt nodes with a composite PK, those FKs are structurally invalid.
 * This migration rebuilds traceroutes without the FKs.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './044_drop_legacy_traceroutes_nodes_fk.js';

function createLegacySchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE nodes (
      nodeNum INTEGER NOT NULL,
      sourceId TEXT NOT NULL,
      PRIMARY KEY (nodeNum, sourceId)
    );
    CREATE TABLE traceroutes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fromNodeNum INTEGER NOT NULL REFERENCES nodes(nodeNum) ON DELETE CASCADE,
      toNodeNum INTEGER NOT NULL REFERENCES nodes(nodeNum) ON DELETE CASCADE,
      fromNodeId TEXT NOT NULL,
      toNodeId TEXT NOT NULL,
      route TEXT,
      routeBack TEXT,
      snrTowards TEXT,
      snrBack TEXT,
      routePositions TEXT,
      channel INTEGER,
      timestamp INTEGER NOT NULL,
      createdAt INTEGER NOT NULL,
      sourceId TEXT
    );
    CREATE INDEX idx_traceroutes_from ON traceroutes(fromNodeNum);
    CREATE INDEX idx_traceroutes_timestamp ON traceroutes(timestamp);
  `);
}

function createBaselineSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE nodes (
      nodeNum INTEGER NOT NULL,
      sourceId TEXT NOT NULL,
      PRIMARY KEY (nodeNum, sourceId)
    );
    CREATE TABLE traceroutes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fromNodeNum INTEGER NOT NULL,
      toNodeNum INTEGER NOT NULL,
      fromNodeId TEXT NOT NULL,
      toNodeId TEXT NOT NULL,
      route TEXT,
      routeBack TEXT,
      snrTowards TEXT,
      snrBack TEXT,
      routePositions TEXT,
      channel INTEGER,
      timestamp INTEGER NOT NULL,
      createdAt INTEGER NOT NULL,
      sourceId TEXT
    );
  `);
}

function hasLegacyFk(db: Database.Database): boolean {
  const rows = db.prepare(`PRAGMA foreign_key_list(traceroutes)`).all() as Array<{
    table: string;
    from: string;
    to: string;
  }>;
  return rows.some((r) => String(r.table).toLowerCase() === 'nodes');
}

function insertTraceroute(db: Database.Database, from: number, to: number, sourceId: string | null) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO traceroutes (fromNodeNum, toNodeNum, fromNodeId, toNodeId, timestamp, createdAt, sourceId)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(from, to, `!${from.toString(16)}`, `!${to.toString(16)}`, now, now, sourceId);
}

describe('Migration 044 — drop legacy traceroutes FK', () => {
  let db: Database.Database;

  describe('legacy schema with FK present', () => {
    beforeEach(() => {
      db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      createLegacySchema(db);
      db.pragma('foreign_keys = OFF');
      insertTraceroute(db, 100, 200, 'src-1');
      insertTraceroute(db, 300, 400, null);
      db.pragma('foreign_keys = ON');
    });

    it('removes the FKs from traceroutes', () => {
      expect(hasLegacyFk(db)).toBe(true);
      migration.up(db);
      expect(hasLegacyFk(db)).toBe(false);
    });

    it('preserves all traceroutes rows', () => {
      migration.up(db);
      const rows = db.prepare(`SELECT fromNodeNum, toNodeNum, sourceId FROM traceroutes ORDER BY id`).all() as any[];
      expect(rows).toHaveLength(2);
      expect(rows[0].fromNodeNum).toBe(100);
      expect(rows[0].sourceId).toBe('src-1');
      expect(rows[1].fromNodeNum).toBe(300);
      expect(rows[1].sourceId).toBeNull();
    });

    it('recreates non-auto indexes', () => {
      migration.up(db);
      const idxs = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='traceroutes' AND name NOT LIKE 'sqlite_autoindex_%'`)
        .all() as Array<{ name: string }>;
      const names = idxs.map((r) => r.name).sort();
      expect(names).toContain('idx_traceroutes_from');
      expect(names).toContain('idx_traceroutes_timestamp');
    });

    it('restores foreign_keys=ON after running', () => {
      migration.up(db);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    });

    it('allows DELETE on traceroutes after the rebuild', () => {
      migration.up(db);
      expect(() => db.prepare(`DELETE FROM traceroutes WHERE sourceId IS NULL`).run()).not.toThrow();
      const remaining = db.prepare(`SELECT COUNT(*) c FROM traceroutes`).get() as any;
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
      insertTraceroute(db, 100, 200, 'src-1');
    });

    it('is a no-op when no legacy FK is present', () => {
      expect(hasLegacyFk(db)).toBe(false);
      migration.up(db);
      expect(hasLegacyFk(db)).toBe(false);
      const rows = db.prepare(`SELECT COUNT(*) c FROM traceroutes`).get() as any;
      expect(rows.c).toBe(1);
    });
  });
});
