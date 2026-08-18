/**
 * Migration 148 tests — relabel historical envCurrent telemetry rows 'A' -> 'mA'.
 */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { migration, runMigration148Postgres, runMigration148Mysql } from './148_fix_env_current_unit.js';

function makeTelemetryTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE telemetry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nodeId TEXT NOT NULL,
      nodeNum INTEGER NOT NULL,
      telemetryType TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      value REAL NOT NULL,
      unit TEXT,
      createdAt INTEGER NOT NULL
    )
  `);
}

function insertRow(db: Database.Database, telemetryType: string, value: number, unit: string | null): void {
  db.prepare(
    `INSERT INTO telemetry (nodeId, nodeNum, telemetryType, timestamp, value, unit, createdAt)
     VALUES ('!1', 1, ?, 100, ?, ?, 100)`
  ).run(telemetryType, value, unit);
}

describe('Migration 148 — fix envCurrent unit', () => {
  describe('SQLite', () => {
    it("relabels envCurrent 'A' rows to 'mA' without touching the value", () => {
      const db = new Database(':memory:');
      makeTelemetryTable(db);
      insertRow(db, 'envCurrent', 0.12, 'A');

      migration.up(db);

      const row = db.prepare(`SELECT value, unit FROM telemetry WHERE telemetryType = 'envCurrent'`).get() as {
        value: number;
        unit: string;
      };
      expect(row.unit).toBe('mA');
      expect(row.value).toBeCloseTo(0.12, 5);
      db.close();
    });

    it('leaves other telemetry types and already-correct units untouched', () => {
      const db = new Database(':memory:');
      makeTelemetryTable(db);
      insertRow(db, 'envVoltage', 3.7, 'V');
      insertRow(db, 'ch1Current', 250, 'mA');
      insertRow(db, 'envCurrent', 42, 'mA'); // already correct — must not double-touch

      migration.up(db);

      const units = db
        .prepare(`SELECT telemetryType, unit FROM telemetry ORDER BY id`)
        .all() as Array<{ telemetryType: string; unit: string }>;
      expect(units).toEqual([
        { telemetryType: 'envVoltage', unit: 'V' },
        { telemetryType: 'ch1Current', unit: 'mA' },
        { telemetryType: 'envCurrent', unit: 'mA' },
      ]);
      db.close();
    });

    it('is idempotent', () => {
      const db = new Database(':memory:');
      makeTelemetryTable(db);
      insertRow(db, 'envCurrent', 1, 'A');

      migration.up(db);
      expect(() => migration.up(db)).not.toThrow();

      const count = db
        .prepare(`SELECT COUNT(*) AS n FROM telemetry WHERE telemetryType = 'envCurrent' AND unit = 'mA'`)
        .get() as { n: number };
      expect(count.n).toBe(1);
      db.close();
    });
  });

  describe('PostgreSQL', () => {
    it("issues a guarded UPDATE relabeling 'A' -> 'mA'", async () => {
      const client = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
      await runMigration148Postgres(client as any);
      const sql = client.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(sql).toMatch(/UPDATE telemetry SET "unit" = 'mA'/);
      expect(sql).toMatch(/"telemetryType" = 'envCurrent'/);
      expect(sql).toMatch(/"unit" = 'A'/);
    });
  });

  describe('MySQL', () => {
    it("issues a guarded UPDATE relabeling 'A' -> 'mA'", async () => {
      const pool = { query: vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]) };
      await runMigration148Mysql(pool as any);
      const sql = pool.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(sql).toMatch(/UPDATE telemetry SET unit = 'mA'/);
      expect(sql).toMatch(/telemetryType = 'envCurrent'/);
      expect(sql).toMatch(/unit = 'A'/);
    });
  });
});
