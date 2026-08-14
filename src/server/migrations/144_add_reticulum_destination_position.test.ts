/**
 * Tests for migration 144 — position columns on `reticulum_destinations`
 * (Reticulum epic #3960, Phase 3 WP3).
 */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { migration, runMigration144Postgres, runMigration144Mysql } from './144_add_reticulum_destination_position.js';

/** The table as migration 141 leaves it — no position columns. */
function createParentTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reticulum_destinations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sourceId TEXT NOT NULL,
      destinationHash TEXT NOT NULL,
      identityHash TEXT, appName TEXT, aspects TEXT, displayName TEXT, appDataB64 TEXT,
      hops INTEGER, nextHopInterface TEXT,
      rssi INTEGER, snr REAL, quality INTEGER,
      announceCount INTEGER NOT NULL DEFAULT 0,
      firstSeen INTEGER NOT NULL, lastSeen INTEGER NOT NULL, lastAnnounceAt INTEGER,
      isFavorite INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
    )
  `);
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

describe('Migration 144 — reticulum_destinations position columns', () => {
  describe('SQLite', () => {
    it('adds all seven position columns and is idempotent (second up() does not throw)', () => {
      const db = new Database(':memory:');
      createParentTable(db);

      migration.up(db);
      expect(() => migration.up(db)).not.toThrow();

      const cols = columnNames(db, 'reticulum_destinations');
      expect(cols).toContain('latitude');
      expect(cols).toContain('longitude');
      expect(cols).toContain('altitude');
      expect(cols).toContain('speed');
      expect(cols).toContain('bearing');
      expect(cols).toContain('accuracy');
      expect(cols).toContain('positionUpdatedAt');

      db.close();
    });

    it('existing rows read null for the new columns, and a position sample round-trips', () => {
      const db = new Database(':memory:');
      createParentTable(db);
      db.prepare(`
        INSERT INTO reticulum_destinations
          (sourceId, destinationHash, announceCount, firstSeen, lastSeen, isFavorite, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('src-1', 'a'.repeat(32), 1, 1000, 1000, 0, 1000, 1000);

      migration.up(db);

      const before = db.prepare(`SELECT * FROM reticulum_destinations WHERE destinationHash = ?`).get('a'.repeat(32)) as any;
      expect(before.latitude).toBeNull();
      expect(before.positionUpdatedAt).toBeNull();

      db.prepare(`
        UPDATE reticulum_destinations
        SET latitude = ?, longitude = ?, altitude = ?, speed = ?, bearing = ?, accuracy = ?, positionUpdatedAt = ?
        WHERE destinationHash = ?
      `).run(10.5, -20.25, 100.0, 1.5, 270.0, 5.0, 1_700_000_000_000, 'a'.repeat(32));

      const after = db.prepare(`SELECT * FROM reticulum_destinations WHERE destinationHash = ?`).get('a'.repeat(32)) as any;
      expect(after.latitude).toBeCloseTo(10.5);
      expect(after.longitude).toBeCloseTo(-20.25);
      expect(after.altitude).toBeCloseTo(100.0);
      expect(after.speed).toBeCloseTo(1.5);
      expect(after.bearing).toBeCloseTo(270.0);
      expect(after.accuracy).toBeCloseTo(5.0);
      expect(after.positionUpdatedAt).toBe(1_700_000_000_000);

      db.close();
    });
  });

  describe('PostgreSQL', () => {
    it('adds all seven position columns via IF NOT EXISTS', async () => {
      const client = { query: vi.fn().mockResolvedValue(undefined) };
      await runMigration144Postgres(client as any);
      const sql = client.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(sql).toContain('ADD COLUMN IF NOT EXISTS "latitude" DOUBLE PRECISION');
      expect(sql).toContain('ADD COLUMN IF NOT EXISTS "longitude" DOUBLE PRECISION');
      expect(sql).toContain('ADD COLUMN IF NOT EXISTS "altitude" DOUBLE PRECISION');
      expect(sql).toContain('ADD COLUMN IF NOT EXISTS "speed" DOUBLE PRECISION');
      expect(sql).toContain('ADD COLUMN IF NOT EXISTS "bearing" DOUBLE PRECISION');
      expect(sql).toContain('ADD COLUMN IF NOT EXISTS "accuracy" DOUBLE PRECISION');
      // ms-epoch timestamps overflow 32-bit INTEGER.
      expect(sql).toContain('ADD COLUMN IF NOT EXISTS "positionUpdatedAt" BIGINT');
    });

    it('is idempotent (native IF NOT EXISTS, no pre-check needed)', async () => {
      const client = { query: vi.fn().mockResolvedValue(undefined) };
      await runMigration144Postgres(client as any);
      await expect(runMigration144Postgres(client as any)).resolves.toBeUndefined();
    });
  });

  describe('MySQL', () => {
    function makeConn(existingColumns: string[]) {
      return {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('information_schema.COLUMNS')) {
            return Promise.resolve([existingColumns.map((c) => ({ COLUMN_NAME: c }))]);
          }
          return Promise.resolve([[]]);
        }),
        release: vi.fn(),
      };
    }

    it('adds all seven position columns when missing', async () => {
      const conn = makeConn([]);
      const pool = { getConnection: vi.fn().mockResolvedValue(conn) };

      await runMigration144Mysql(pool as any);

      const ddl = conn.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(ddl).toContain('ALTER TABLE reticulum_destinations ADD COLUMN latitude DOUBLE');
      expect(ddl).toContain('ALTER TABLE reticulum_destinations ADD COLUMN longitude DOUBLE');
      expect(ddl).toContain('ALTER TABLE reticulum_destinations ADD COLUMN altitude DOUBLE');
      expect(ddl).toContain('ALTER TABLE reticulum_destinations ADD COLUMN speed DOUBLE');
      expect(ddl).toContain('ALTER TABLE reticulum_destinations ADD COLUMN bearing DOUBLE');
      expect(ddl).toContain('ALTER TABLE reticulum_destinations ADD COLUMN accuracy DOUBLE');
      expect(ddl).toContain('ALTER TABLE reticulum_destinations ADD COLUMN positionUpdatedAt BIGINT');
      expect(conn.release).toHaveBeenCalled();
    });

    it('skips ALTER TABLE for columns that already exist (pre-check via information_schema)', async () => {
      const conn = makeConn(['latitude', 'longitude', 'altitude', 'speed', 'bearing', 'accuracy', 'positionUpdatedAt']);
      const pool = { getConnection: vi.fn().mockResolvedValue(conn) };

      await runMigration144Mysql(pool as any);

      const ddl = conn.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(ddl).not.toContain('ALTER TABLE');
      expect(conn.release).toHaveBeenCalled();
    });
  });
});
