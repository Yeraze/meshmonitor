/**
 * Tests for migration 222 — live RNode interface-gauge columns on
 * `reticulum_interfaces` (issue #6120).
 */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { migration, runMigration222Postgres, runMigration222Mysql } from './222_add_reticulum_interface_live_stats.js';

const NEW_COLUMNS = [
  'airtimeShort', 'airtimeLong', 'channelLoadShort', 'channelLoadLong',
  'noiseFloor', 'interference', 'interferenceLastTs', 'interferenceLastDbm',
  'cpuLoad', 'batteryState', 'batteryPercent',
];

/** The table as migrations 142/145 leave it — no live-gauge columns yet. */
function createParentTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reticulum_interfaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sourceId TEXT NOT NULL,
      interfaceName TEXT NOT NULL,
      interfaceType TEXT, interfaceHash TEXT, mode TEXT,
      status TEXT NOT NULL, online INTEGER NOT NULL DEFAULT 0, bitrate INTEGER,
      txBytes INTEGER NOT NULL DEFAULT 0, rxBytes INTEGER NOT NULL DEFAULT 0,
      lastSeenAt INTEGER NOT NULL,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
    )
  `);
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

describe('Migration 222 — reticulum_interfaces live interface-gauge columns', () => {
  describe('SQLite', () => {
    it('adds all eleven gauge columns and is idempotent (second up() does not throw)', () => {
      const db = new Database(':memory:');
      createParentTable(db);

      migration.up(db);
      expect(() => migration.up(db)).not.toThrow();

      const cols = columnNames(db, 'reticulum_interfaces');
      for (const c of NEW_COLUMNS) expect(cols).toContain(c);

      db.close();
    });

    it('existing rows read null for the new columns, and a gauge snapshot round-trips', () => {
      const db = new Database(':memory:');
      createParentTable(db);
      db.prepare(`
        INSERT INTO reticulum_interfaces
          (sourceId, interfaceName, status, online, txBytes, rxBytes, lastSeenAt, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('src-1', 'RNode LoRa Interface', 'up', 1, 0, 0, 1000, 1000, 1000);

      migration.up(db);

      const before = db.prepare(`SELECT * FROM reticulum_interfaces WHERE interfaceName = ?`).get('RNode LoRa Interface') as any;
      expect(before.airtimeShort).toBeNull();
      expect(before.noiseFloor).toBeNull();
      expect(before.batteryState).toBeNull();
      expect(before.batteryPercent).toBeNull();

      db.prepare(`
        UPDATE reticulum_interfaces
        SET airtimeShort = ?, airtimeLong = ?, channelLoadShort = ?, channelLoadLong = ?,
            noiseFloor = ?, interference = ?, interferenceLastTs = ?, interferenceLastDbm = ?,
            cpuLoad = ?, batteryState = ?, batteryPercent = ?
        WHERE interfaceName = ?
      `).run(0, 0.12, 2.44, 1.15, -109, -86, 1700000000, -86, 4.2, 'discharging', 100, 'RNode LoRa Interface');

      const after = db.prepare(`SELECT * FROM reticulum_interfaces WHERE interfaceName = ?`).get('RNode LoRa Interface') as any;
      expect(after.airtimeLong).toBeCloseTo(0.12);
      expect(after.channelLoadShort).toBeCloseTo(2.44);
      expect(after.noiseFloor).toBe(-109);
      expect(after.interference).toBe(-86);
      expect(after.interferenceLastTs).toBe(1700000000);
      expect(after.interferenceLastDbm).toBe(-86);
      expect(after.cpuLoad).toBeCloseTo(4.2);
      expect(after.batteryState).toBe('discharging');
      expect(after.batteryPercent).toBe(100);

      db.close();
    });
  });

  describe('PostgreSQL', () => {
    it('adds all eleven columns via IF NOT EXISTS', async () => {
      const client = { query: vi.fn().mockResolvedValue(undefined) };
      await runMigration222Postgres(client as any);
      const sql = client.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(sql).toContain('ADD COLUMN IF NOT EXISTS "airtimeShort" DOUBLE PRECISION');
      expect(sql).toContain('ADD COLUMN IF NOT EXISTS "channelLoadLong" DOUBLE PRECISION');
      expect(sql).toContain('ADD COLUMN IF NOT EXISTS "noiseFloor" DOUBLE PRECISION');
      expect(sql).toContain('ADD COLUMN IF NOT EXISTS "interferenceLastTs" DOUBLE PRECISION');
      expect(sql).toContain('ADD COLUMN IF NOT EXISTS "cpuLoad" DOUBLE PRECISION');
      expect(sql).toContain('ADD COLUMN IF NOT EXISTS "batteryState" TEXT');
      expect(sql).toContain('ADD COLUMN IF NOT EXISTS "batteryPercent" DOUBLE PRECISION');
    });

    it('is idempotent (native IF NOT EXISTS, no pre-check needed)', async () => {
      const client = { query: vi.fn().mockResolvedValue(undefined) };
      await runMigration222Postgres(client as any);
      await expect(runMigration222Postgres(client as any)).resolves.toBeUndefined();
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

    it('adds all eleven columns when missing', async () => {
      const conn = makeConn([]);
      const pool = { getConnection: vi.fn().mockResolvedValue(conn) };

      await runMigration222Mysql(pool as any);

      const ddl = conn.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(ddl).toContain('ALTER TABLE reticulum_interfaces ADD COLUMN airtimeShort DOUBLE');
      expect(ddl).toContain('ALTER TABLE reticulum_interfaces ADD COLUMN channelLoadLong DOUBLE');
      expect(ddl).toContain('ALTER TABLE reticulum_interfaces ADD COLUMN noiseFloor DOUBLE');
      expect(ddl).toContain('ALTER TABLE reticulum_interfaces ADD COLUMN interferenceLastTs DOUBLE');
      expect(ddl).toContain('ALTER TABLE reticulum_interfaces ADD COLUMN cpuLoad DOUBLE');
      expect(ddl).toContain('ALTER TABLE reticulum_interfaces ADD COLUMN batteryState VARCHAR(32)');
      expect(ddl).toContain('ALTER TABLE reticulum_interfaces ADD COLUMN batteryPercent DOUBLE');
      expect(conn.release).toHaveBeenCalled();
    });

    it('skips ALTER TABLE for columns that already exist (pre-check via information_schema)', async () => {
      const conn = makeConn(NEW_COLUMNS);
      const pool = { getConnection: vi.fn().mockResolvedValue(conn) };

      await runMigration222Mysql(pool as any);

      const ddl = conn.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(ddl).not.toContain('ALTER TABLE');
      expect(conn.release).toHaveBeenCalled();
    });
  });
});
