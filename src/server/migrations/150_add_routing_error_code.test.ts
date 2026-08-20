/**
 * Tests for migration 150 — `routingErrorCode` column on `messages`
 * (#4816 Phase 2, Delivery Diagnostics).
 */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { migration, runMigration150Postgres, runMigration150Mysql } from './150_add_routing_error_code.js';

/** A minimal `messages` table without the routingErrorCode column. */
function createParentTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      fromNodeNum INTEGER NOT NULL,
      toNodeNum INTEGER NOT NULL,
      fromNodeId TEXT NOT NULL,
      toNodeId TEXT NOT NULL,
      text TEXT NOT NULL,
      channel INTEGER NOT NULL DEFAULT 0,
      requestId INTEGER,
      timestamp INTEGER NOT NULL,
      deliveryState TEXT,
      createdAt INTEGER NOT NULL DEFAULT 0
    )
  `);
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

describe('Migration 150 — messages.routingErrorCode', () => {
  describe('SQLite', () => {
    it('adds routingErrorCode and is idempotent (second up() does not throw)', () => {
      const db = new Database(':memory:');
      createParentTable(db);

      expect(columnNames(db, 'messages')).not.toContain('routingErrorCode');

      migration.up(db);
      expect(() => migration.up(db)).not.toThrow();

      const cols = columnNames(db, 'messages');
      expect(cols).toContain('routingErrorCode');

      db.close();
    });

    it('existing rows read null for the new column, and a failed-delivery code round-trips', () => {
      const db = new Database(':memory:');
      createParentTable(db);
      db.prepare(`
        INSERT INTO messages (id, fromNodeNum, toNodeNum, fromNodeId, toNodeId, text, requestId, timestamp, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('msg-1', 1, 2, '!00000001', '!00000002', 'hi', 42, 1000, 1000);

      migration.up(db);

      const before = db.prepare(`SELECT * FROM messages WHERE id = ?`).get('msg-1') as any;
      expect(before.routingErrorCode).toBeNull();

      db.prepare(`UPDATE messages SET deliveryState = ?, routingErrorCode = ? WHERE id = ?`)
        .run('failed', 5, 'msg-1');
      const after = db.prepare(`SELECT * FROM messages WHERE id = ?`).get('msg-1') as any;
      expect(after.routingErrorCode).toBe(5);
      expect(after.deliveryState).toBe('failed');

      db.close();
    });
  });

  describe('PostgreSQL', () => {
    it('adds routingErrorCode via ADD COLUMN IF NOT EXISTS with quoted camelCase', async () => {
      const calls: string[] = [];
      const client = { query: vi.fn(async (sql: string) => { calls.push(sql); return { rows: [] }; }) } as any;

      await runMigration150Postgres(client);

      const joined = calls.join('\n');
      expect(joined).toMatch(/ADD COLUMN IF NOT EXISTS "routingErrorCode" INTEGER/);
    });

    it('is idempotent (native IF NOT EXISTS, no pre-check needed)', async () => {
      const client = { query: vi.fn().mockResolvedValue({ rows: [] }) } as any;
      await runMigration150Postgres(client);
      await expect(runMigration150Postgres(client)).resolves.toBeUndefined();
    });
  });

  describe('MySQL', () => {
    it('pre-checks information_schema then adds the missing column', async () => {
      const conn = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('information_schema.COLUMNS')) return Promise.resolve([[]]);
          return Promise.resolve([[]]);
        }),
        release: vi.fn(),
      };
      const pool = { getConnection: vi.fn().mockResolvedValue(conn) } as any;

      await runMigration150Mysql(pool);

      const ddl = conn.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(ddl).toContain('ALTER TABLE messages ADD COLUMN routingErrorCode INT');
      expect(conn.release).toHaveBeenCalled();
    });

    it('skips ALTER TABLE when the column already exists', async () => {
      const conn = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('information_schema.COLUMNS')) {
            return Promise.resolve([[{ COLUMN_NAME: 'routingErrorCode' }]]);
          }
          return Promise.resolve([[]]);
        }),
        release: vi.fn(),
      };
      const pool = { getConnection: vi.fn().mockResolvedValue(conn) } as any;

      await runMigration150Mysql(pool);

      const ddl = conn.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(ddl).not.toContain('ALTER TABLE');
      expect(conn.release).toHaveBeenCalled();
    });
  });
});
