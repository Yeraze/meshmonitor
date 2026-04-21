/**
 * Migration 041 — Drop legacy telemetry→nodes(nodeNum) FK
 *
 * Legacy v3.x SQLite databases carry a `telemetry.nodeNum REFERENCES
 * nodes(nodeNum)` FK. After migration 029 rebuilt nodes with a composite
 * PK, that FK is structurally invalid. This migration rebuilds telemetry
 * without the FK so future DML doesn't need to toggle foreign_keys.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './041_drop_legacy_telemetry_nodes_fk.js';

function createLegacySchema(db: Database.Database) {
  db.exec(`
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
    CREATE INDEX idx_telemetry_nodenum ON telemetry(nodeNum);
    CREATE INDEX idx_telemetry_timestamp ON telemetry(timestamp);
  `);
}

function createBaselineSchema(db: Database.Database) {
  db.exec(`
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
      sourceId TEXT
    );
  `);
}

function hasLegacyFk(db: Database.Database): boolean {
  const rows = db.prepare(`PRAGMA foreign_key_list(telemetry)`).all() as Array<{
    table: string;
    from: string;
    to: string;
  }>;
  return rows.some((r) => String(r.table).toLowerCase() === 'nodes' && r.from === 'nodeNum');
}

function insertTelemetry(db: Database.Database, nodeNum: number, sourceId: string | null) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO telemetry (nodeId, nodeNum, telemetryType, timestamp, value, unit, createdAt, sourceId)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(`!${nodeNum.toString(16).padStart(8, '0')}`, nodeNum, 'batteryLevel', now, 42, '%', now, sourceId);
}

describe('Migration 041 — drop legacy telemetry FK', () => {
  let db: Database.Database;

  describe('legacy schema with FK present', () => {
    beforeEach(() => {
      db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      createLegacySchema(db);
      // Seed with FKs off — the broken FK blocks INSERT with FKs on.
      db.pragma('foreign_keys = OFF');
      insertTelemetry(db, 100, 'src-1');
      insertTelemetry(db, 200, null);
      db.pragma('foreign_keys = ON');
    });

    it('removes the FK from telemetry', () => {
      expect(hasLegacyFk(db)).toBe(true);
      migration.up(db);
      expect(hasLegacyFk(db)).toBe(false);
    });

    it('preserves all telemetry rows', () => {
      migration.up(db);
      const rows = db.prepare(`SELECT id, nodeNum, sourceId FROM telemetry ORDER BY id`).all() as any[];
      expect(rows).toHaveLength(2);
      expect(rows[0].nodeNum).toBe(100);
      expect(rows[0].sourceId).toBe('src-1');
      expect(rows[1].nodeNum).toBe(200);
      expect(rows[1].sourceId).toBeNull();
    });

    it('recreates non-auto indexes', () => {
      migration.up(db);
      const idxs = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='telemetry' AND name NOT LIKE 'sqlite_autoindex_%'`)
        .all() as Array<{ name: string }>;
      const names = idxs.map((r) => r.name).sort();
      expect(names).toContain('idx_telemetry_nodenum');
      expect(names).toContain('idx_telemetry_timestamp');
    });

    it('restores foreign_keys=ON after running', () => {
      migration.up(db);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    });

    it('allows DELETE on telemetry after the rebuild', () => {
      migration.up(db);
      expect(() => db.prepare(`DELETE FROM telemetry WHERE sourceId IS NULL`).run()).not.toThrow();
      const remaining = db.prepare(`SELECT COUNT(*) c FROM telemetry`).get() as any;
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
      insertTelemetry(db, 100, 'src-1');
    });

    it('is a no-op when no legacy FK is present', () => {
      expect(hasLegacyFk(db)).toBe(false);
      migration.up(db);
      expect(hasLegacyFk(db)).toBe(false);
      const rows = db.prepare(`SELECT COUNT(*) c FROM telemetry`).get() as any;
      expect(rows.c).toBe(1);
    });
  });
});
