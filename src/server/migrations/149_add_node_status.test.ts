/**
 * Tests for migration 149 — `nodeStatus` + `nodeStatusUpdatedAt` columns on
 * `nodes` (Status Message receive side, #4818).
 */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { migration, runMigration149Postgres, runMigration149Mysql } from './149_add_node_status.js';

/** A minimal `nodes` table without the status columns. */
function createParentTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      nodeNum INTEGER NOT NULL,
      nodeId TEXT NOT NULL,
      longName TEXT,
      shortName TEXT,
      sourceId TEXT NOT NULL DEFAULT 'default',
      createdAt INTEGER NOT NULL DEFAULT 0,
      updatedAt INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (nodeNum, sourceId)
    )
  `);
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

describe('Migration 149 — nodes status columns', () => {
  describe('SQLite', () => {
    it('adds nodeStatus + nodeStatusUpdatedAt and is idempotent (second up() does not throw)', () => {
      const db = new Database(':memory:');
      createParentTable(db);

      migration.up(db);
      expect(() => migration.up(db)).not.toThrow();

      const cols = columnNames(db, 'nodes');
      expect(cols).toContain('nodeStatus');
      expect(cols).toContain('nodeStatusUpdatedAt');

      db.close();
    });

    it('existing rows read null for the new columns, and a status write round-trips', () => {
      const db = new Database(':memory:');
      createParentTable(db);
      db.prepare(`INSERT INTO nodes (nodeNum, nodeId, sourceId) VALUES (?, ?, ?)`)
        .run(0x11111111, '!11111111', 'default');

      migration.up(db);

      const before = db.prepare(`SELECT * FROM nodes WHERE nodeNum = ?`).get(0x11111111) as any;
      expect(before.nodeStatus).toBeNull();
      expect(before.nodeStatusUpdatedAt).toBeNull();

      db.prepare(`UPDATE nodes SET nodeStatus = ?, nodeStatusUpdatedAt = ? WHERE nodeNum = ?`)
        .run('On the ridge', 1234, 0x11111111);
      const after = db.prepare(`SELECT * FROM nodes WHERE nodeNum = ?`).get(0x11111111) as any;
      expect(after.nodeStatus).toBe('On the ridge');
      expect(after.nodeStatusUpdatedAt).toBe(1234);

      db.close();
    });
  });

  describe('PostgreSQL', () => {
    it('adds both columns via ADD COLUMN IF NOT EXISTS with quoted camelCase', async () => {
      const calls: string[] = [];
      const client = { query: vi.fn(async (sql: string) => { calls.push(sql); return { rows: [] }; }) } as any;

      await runMigration149Postgres(client);

      const joined = calls.join('\n');
      expect(joined).toMatch(/ADD COLUMN IF NOT EXISTS "nodeStatus" TEXT/);
      expect(joined).toMatch(/ADD COLUMN IF NOT EXISTS "nodeStatusUpdatedAt" BIGINT/);
    });
  });

  describe('MySQL', () => {
    it('pre-checks information_schema then adds each missing column', async () => {
      // Report every column as absent so the helper proceeds to ADD COLUMN.
      const conn = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('information_schema.COLUMNS')) return Promise.resolve([[]]);
          return Promise.resolve([[]]);
        }),
        release: vi.fn(),
      };
      const pool = { getConnection: vi.fn().mockResolvedValue(conn) } as any;

      await runMigration149Mysql(pool);

      const ddl = conn.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(ddl).toContain('ALTER TABLE nodes ADD COLUMN nodeStatus VARCHAR(80)');
      expect(ddl).toContain('ALTER TABLE nodes ADD COLUMN nodeStatusUpdatedAt BIGINT');
      expect(conn.release).toHaveBeenCalled();
    });
  });
});
