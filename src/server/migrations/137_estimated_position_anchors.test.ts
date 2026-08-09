/**
 * Tests for migration 137 — estimated_position_anchors + estimate rationale
 * columns (issue #4609).
 */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { migration, runMigration137Postgres, runMigration137Mysql } from './137_estimated_position_anchors.js';

/** The parent table as migration 082/091 leave it — no nEff/radiusMethod. */
function createParentTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS estimated_positions (
      nodeNum INTEGER PRIMARY KEY,
      nodeId TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      uncertaintyKm REAL,
      observationCount INTEGER NOT NULL DEFAULT 0,
      updatedAt INTEGER NOT NULL
    )
  `);
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

describe('Migration 137 — estimated_position_anchors', () => {
  describe('SQLite', () => {
    it('creates the table and is idempotent (second up() does not throw)', () => {
      const db = new Database(':memory:');
      createParentTable(db);

      migration.up(db);
      expect(() => migration.up(db)).not.toThrow();

      const table = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name = 'estimated_position_anchors'`
      ).get();
      expect(table).toBeTruthy();

      db.close();
    });

    it('adds nEff and radiusMethod to estimated_positions without disturbing existing rows', () => {
      const db = new Database(':memory:');
      createParentTable(db);
      db.prepare(`
        INSERT INTO estimated_positions (nodeNum, nodeId, latitude, longitude, uncertaintyKm, observationCount, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(305419896, '!12345678', 10.5, 20.5, 5.0, 3, 1_700_000_000_000);

      migration.up(db);

      const cols = columnNames(db, 'estimated_positions');
      expect(cols).toContain('nEff');
      expect(cols).toContain('radiusMethod');

      // Pre-existing rows survive and read NULL for the new columns — the API
      // must report "unknown", never a guessed derivation.
      const row = db.prepare(`SELECT * FROM estimated_positions WHERE nodeNum = ?`).get(305419896) as any;
      expect(row.latitude).toBe(10.5);
      expect(row.nEff).toBeNull();
      expect(row.radiusMethod).toBeNull();

      db.close();
    });

    it('creates the nodeNum lookup indexes', () => {
      const db = new Database(':memory:');
      createParentTable(db);
      migration.up(db);

      const indexes = (db.prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='estimated_position_anchors'`
      ).all() as Array<{ name: string }>).map((r) => r.name);
      expect(indexes).toContain('epa_node_idx');
      expect(indexes).toContain('epa_node_weight_idx');

      db.close();
    });

    it('round-trips a full anchor row, including a null SNR', () => {
      const db = new Database(':memory:');
      createParentTable(db);
      migration.up(db);

      const insert = db.prepare(`
        INSERT INTO estimated_position_anchors (
          nodeNum, anchorNodeNum, anchorNodeId, anchorLat, anchorLon,
          kind, snrDb, observedAt, weight, createdAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insert.run(1, 2, '!00000002', 10.25, -20.75, 'traceroute', 3.25, 1_700_000_000_000, 0.5, 1_700_000_100_000);
      insert.run(1, 3, '!00000003', 11.0, -21.0, 'neighbor', null, 1_700_000_000_000, 0.25, 1_700_000_100_000);

      const rows = db.prepare(
        `SELECT * FROM estimated_position_anchors WHERE nodeNum = ? ORDER BY weight DESC`
      ).all(1) as any[];

      expect(rows).toHaveLength(2);
      expect(rows[0].anchorNodeId).toBe('!00000002');
      expect(rows[0].kind).toBe('traceroute');
      expect(rows[0].snrDb).toBe(3.25);
      expect(rows[0].anchorLat).toBe(10.25);
      // A NeighborInfo pair with no reported SNR is legitimate — it must store
      // as NULL rather than being coerced to 0, which would read as a real
      // measurement.
      expect(rows[1].snrDb).toBeNull();
      expect(rows[1].kind).toBe('neighbor');

      db.close();
    });

    it('is GLOBAL — there is deliberately no sourceId column', () => {
      const db = new Database(':memory:');
      createParentTable(db);
      migration.up(db);

      // Anchors pool observations from every Meshtastic source into one
      // estimate per physical nodeNum (#3271), so no single sourceId is
      // correct. Guard against a well-meaning "add sourceId out of habit".
      expect(columnNames(db, 'estimated_position_anchors')).not.toContain('sourceId');

      db.close();
    });

    it('down() drops the table', () => {
      const db = new Database(':memory:');
      createParentTable(db);
      migration.up(db);
      migration.down(db);

      const table = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name = 'estimated_position_anchors'`
      ).get();
      expect(table).toBeUndefined();

      db.close();
    });
  });

  describe('PostgreSQL', () => {
    it('creates the table and indexes with IF NOT EXISTS and adds both columns', async () => {
      const client = { query: vi.fn().mockResolvedValue({ rows: [] }) } as any;

      await runMigration137Postgres(client);

      const sql = client.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS estimated_position_anchors');
      expect(sql).toContain('CREATE INDEX IF NOT EXISTS epa_node_idx');
      expect(sql).toContain('CREATE INDEX IF NOT EXISTS epa_node_weight_idx');
      // BIGINT for node numbers: nodeNum is unsigned 32-bit and overflows PG INTEGER.
      expect(sql).toContain('"nodeNum" BIGINT NOT NULL');
      expect(sql).toContain('"anchorNodeNum" BIGINT NOT NULL');
      // doublePrecision, not REAL — REAL rounds coordinates.
      expect(sql).toContain('"anchorLat" DOUBLE PRECISION NOT NULL');
      expect(sql).toContain('"nEff"');
      expect(sql).toContain('"radiusMethod"');
      expect(sql).not.toContain('sourceId');
    });
  });

  describe('MySQL', () => {
    it('pre-checks information_schema before creating the table', async () => {
      const conn = {
        query: vi.fn().mockResolvedValue([[]]),
        release: vi.fn(),
      };
      const pool = {
        getConnection: vi.fn().mockResolvedValue(conn),
        query: vi.fn().mockResolvedValue([[]]),
      } as any;

      await runMigration137Mysql(pool);

      const sql = [
        ...conn.query.mock.calls.map((c: any[]) => String(c[0])),
        ...pool.query.mock.calls.map((c: any[]) => String(c[0])),
      ].join('\n');

      // MySQL has no CREATE TABLE/INDEX IF NOT EXISTS for our purposes, so the
      // helpers must consult information_schema first.
      expect(sql).toContain('information_schema');
      expect(sql).toContain('estimated_position_anchors');
      expect(conn.release).toHaveBeenCalled();
    });
  });
});
