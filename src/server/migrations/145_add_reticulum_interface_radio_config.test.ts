/**
 * Tests for migration 145 — own-mode radio-config + device-info columns on
 * `reticulum_interfaces` (Reticulum epic #3960, Phase 3 WP3).
 */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { migration, runMigration145Postgres, runMigration145Mysql } from './145_add_reticulum_interface_radio_config.js';

/** The table as migration 142 leaves it — no radio-config columns. */
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

describe('Migration 145 — reticulum_interfaces radio-config columns', () => {
  describe('SQLite', () => {
    it('adds all nine radio-config/device-info columns and is idempotent (second up() does not throw)', () => {
      const db = new Database(':memory:');
      createParentTable(db);

      migration.up(db);
      expect(() => migration.up(db)).not.toThrow();

      const cols = columnNames(db, 'reticulum_interfaces');
      expect(cols).toContain('frequency');
      expect(cols).toContain('bandwidth');
      expect(cols).toContain('spreadingFactor');
      expect(cols).toContain('codingRate');
      expect(cols).toContain('txPower');
      expect(cols).toContain('stAlock');
      expect(cols).toContain('ltAlock');
      expect(cols).toContain('radioState');
      expect(cols).toContain('deviceInfoJson');

      db.close();
    });

    it('existing rows read null for the new columns, and a radio-config patch round-trips', () => {
      const db = new Database(':memory:');
      createParentTable(db);
      db.prepare(`
        INSERT INTO reticulum_interfaces
          (sourceId, interfaceName, status, online, txBytes, rxBytes, lastSeenAt, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('src-1', 'RNodeInterface[/dev/ttyUSB0]', 'up', 1, 0, 0, 1000, 1000, 1000);

      migration.up(db);

      const before = db.prepare(`SELECT * FROM reticulum_interfaces WHERE interfaceName = ?`).get('RNodeInterface[/dev/ttyUSB0]') as any;
      expect(before.frequency).toBeNull();
      expect(before.radioState).toBeNull();
      expect(before.deviceInfoJson).toBeNull();

      db.prepare(`
        UPDATE reticulum_interfaces
        SET frequency = ?, bandwidth = ?, spreadingFactor = ?, codingRate = ?, txPower = ?,
            stAlock = ?, ltAlock = ?, radioState = ?, deviceInfoJson = ?
        WHERE interfaceName = ?
      `).run(915000000, 125000, 8, 5, 17, 33.3, 66.6, 1, '{"fw":"1.60","mcu":"1284p"}', 'RNodeInterface[/dev/ttyUSB0]');

      const after = db.prepare(`SELECT * FROM reticulum_interfaces WHERE interfaceName = ?`).get('RNodeInterface[/dev/ttyUSB0]') as any;
      expect(after.frequency).toBeCloseTo(915000000);
      expect(after.bandwidth).toBeCloseTo(125000);
      expect(after.spreadingFactor).toBe(8);
      expect(after.codingRate).toBe(5);
      expect(after.txPower).toBe(17);
      expect(after.stAlock).toBeCloseTo(33.3);
      expect(after.ltAlock).toBeCloseTo(66.6);
      expect(after.radioState).toBe(1);
      expect(after.deviceInfoJson).toBe('{"fw":"1.60","mcu":"1284p"}');

      db.close();
    });
  });

  describe('PostgreSQL', () => {
    it('adds all nine columns via IF NOT EXISTS', async () => {
      const client = { query: vi.fn().mockResolvedValue(undefined) };
      await runMigration145Postgres(client as any);
      const sql = client.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(sql).toContain('ADD COLUMN IF NOT EXISTS "frequency" DOUBLE PRECISION');
      expect(sql).toContain('ADD COLUMN IF NOT EXISTS "bandwidth" DOUBLE PRECISION');
      expect(sql).toContain('ADD COLUMN IF NOT EXISTS "spreadingFactor" INTEGER');
      expect(sql).toContain('ADD COLUMN IF NOT EXISTS "codingRate" INTEGER');
      expect(sql).toContain('ADD COLUMN IF NOT EXISTS "txPower" INTEGER');
      expect(sql).toContain('ADD COLUMN IF NOT EXISTS "stAlock" DOUBLE PRECISION');
      expect(sql).toContain('ADD COLUMN IF NOT EXISTS "ltAlock" DOUBLE PRECISION');
      expect(sql).toContain('ADD COLUMN IF NOT EXISTS "radioState" BOOLEAN');
      expect(sql).toContain('ADD COLUMN IF NOT EXISTS "deviceInfoJson" TEXT');
    });

    it('is idempotent (native IF NOT EXISTS, no pre-check needed)', async () => {
      const client = { query: vi.fn().mockResolvedValue(undefined) };
      await runMigration145Postgres(client as any);
      await expect(runMigration145Postgres(client as any)).resolves.toBeUndefined();
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

    it('adds all nine columns when missing', async () => {
      const conn = makeConn([]);
      const pool = { getConnection: vi.fn().mockResolvedValue(conn) };

      await runMigration145Mysql(pool as any);

      const ddl = conn.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(ddl).toContain('ALTER TABLE reticulum_interfaces ADD COLUMN frequency DOUBLE');
      expect(ddl).toContain('ALTER TABLE reticulum_interfaces ADD COLUMN bandwidth DOUBLE');
      expect(ddl).toContain('ALTER TABLE reticulum_interfaces ADD COLUMN spreadingFactor INT');
      expect(ddl).toContain('ALTER TABLE reticulum_interfaces ADD COLUMN codingRate INT');
      expect(ddl).toContain('ALTER TABLE reticulum_interfaces ADD COLUMN txPower INT');
      expect(ddl).toContain('ALTER TABLE reticulum_interfaces ADD COLUMN stAlock DOUBLE');
      expect(ddl).toContain('ALTER TABLE reticulum_interfaces ADD COLUMN ltAlock DOUBLE');
      expect(ddl).toContain('ALTER TABLE reticulum_interfaces ADD COLUMN radioState TINYINT(1)');
      expect(ddl).toContain('ALTER TABLE reticulum_interfaces ADD COLUMN deviceInfoJson TEXT');
      expect(conn.release).toHaveBeenCalled();
    });

    it('skips ALTER TABLE for columns that already exist (pre-check via information_schema)', async () => {
      const conn = makeConn([
        'frequency', 'bandwidth', 'spreadingFactor', 'codingRate', 'txPower',
        'stAlock', 'ltAlock', 'radioState', 'deviceInfoJson',
      ]);
      const pool = { getConnection: vi.fn().mockResolvedValue(conn) };

      await runMigration145Mysql(pool as any);

      const ddl = conn.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(ddl).not.toContain('ALTER TABLE');
      expect(conn.release).toHaveBeenCalled();
    });
  });
});
