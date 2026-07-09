/**
 * Unit tests for migration idempotency helpers.
 *
 * SQLite tests use an in-memory Database instance so they exercise real SQL.
 * PostgreSQL and MySQL tests use minimal mock objects and assert on the SQL
 * emitted, since spinning up live engines is out-of-scope for unit tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
  createTableIfMissingMysql,
} from './helpers.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function columnNames(db: Database.Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

/**
 * Builds a mysql2-Pool-alike mock.
 *
 * @param existingColumns - column names that the information_schema mock
 *   should report as already present (for COLUMNS queries).
 * @param existingTables  - table names that the information_schema mock
 *   should report as already present (for TABLES queries).
 */
function makeMysqlPool(
  existingColumns: string[] = [],
  existingTables: string[] = [],
): { pool: any; conn: any } {
  const conn = {
    query: vi.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('information_schema.COLUMNS')) {
        const col = Array.isArray(params) ? (params[1] as string) : '';
        return [existingColumns.includes(col) ? [{ COLUMN_NAME: col }] : []];
      }
      if (sql.includes('information_schema.TABLES')) {
        const tbl = Array.isArray(params) ? (params[0] as string) : '';
        return [existingTables.includes(tbl) ? [{ TABLE_NAME: tbl }] : []];
      }
      return [{ affectedRows: 0 }];
    }),
    release: vi.fn(),
  };
  const pool = { getConnection: vi.fn().mockResolvedValue(conn) };
  return { pool, conn };
}

// ─── addColumnIfMissing (SQLite) ──────────────────────────────────────────────

describe('addColumnIfMissing (SQLite)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE nodes (id INTEGER PRIMARY KEY, name TEXT)`);
  });

  it('adds the column when it does not exist', () => {
    expect(columnNames(db, 'nodes')).not.toContain('notes');
    addColumnIfMissing(db, 'nodes', 'notes', 'notes TEXT');
    expect(columnNames(db, 'nodes')).toContain('notes');
  });

  it('is idempotent — second call is a no-op', () => {
    addColumnIfMissing(db, 'nodes', 'notes', 'notes TEXT');
    expect(() => addColumnIfMissing(db, 'nodes', 'notes', 'notes TEXT')).not.toThrow();
    expect(columnNames(db, 'nodes')).toContain('notes');
  });

  it('adds a column with a DEFAULT value', () => {
    addColumnIfMissing(db, 'nodes', 'count', 'count INTEGER DEFAULT 0');
    db.prepare(`INSERT INTO nodes (name) VALUES ('test')`).run();
    const row = db.prepare(`SELECT count FROM nodes WHERE name = 'test'`).get() as { count: number };
    expect(row.count).toBe(0);
  });

  it('re-throws errors that are not duplicate-column', () => {
    expect(() =>
      addColumnIfMissing(db, 'nonexistent_table', 'col', 'col TEXT'),
    ).toThrow();
  });
});

// ─── addColumnIfMissingPostgres ───────────────────────────────────────────────

describe('addColumnIfMissingPostgres', () => {
  it('issues ADD COLUMN IF NOT EXISTS with the provided DDL', async () => {
    const client = { query: vi.fn().mockResolvedValue(undefined) };
    await addColumnIfMissingPostgres(client, 'nodes', 'notes', '"notes" TEXT');
    expect(client.query).toHaveBeenCalledWith(
      'ALTER TABLE nodes ADD COLUMN IF NOT EXISTS "notes" TEXT',
    );
  });

  it('propagates query errors', async () => {
    const client = { query: vi.fn().mockRejectedValue(new Error('pg error')) };
    await expect(
      addColumnIfMissingPostgres(client, 'nodes', 'notes', '"notes" TEXT'),
    ).rejects.toThrow('pg error');
  });
});

// ─── addColumnIfMissingMysql ──────────────────────────────────────────────────

describe('addColumnIfMissingMysql', () => {
  it('issues ALTER TABLE when the column is absent', async () => {
    const { pool, conn } = makeMysqlPool(/* no existing columns */);
    await addColumnIfMissingMysql(pool, 'nodes', 'notes', 'notes VARCHAR(2000)');

    // information_schema check
    expect(conn.query).toHaveBeenCalledWith(
      expect.stringContaining('information_schema.COLUMNS'),
      ['nodes', 'notes'],
    );
    // ALTER TABLE issued
    expect(conn.query).toHaveBeenCalledWith(
      'ALTER TABLE nodes ADD COLUMN notes VARCHAR(2000)',
    );
    expect(conn.release).toHaveBeenCalled();
  });

  it('skips ALTER TABLE when the column already exists', async () => {
    const { pool, conn } = makeMysqlPool(['notes']);
    await addColumnIfMissingMysql(pool, 'nodes', 'notes', 'notes VARCHAR(2000)');

    // Only one query: the information_schema check
    expect(conn.query).toHaveBeenCalledTimes(1);
    expect(conn.query).toHaveBeenCalledWith(
      expect.stringContaining('information_schema.COLUMNS'),
      ['nodes', 'notes'],
    );
    expect(conn.release).toHaveBeenCalled();
  });

  it('releases the connection even when ALTER TABLE throws', async () => {
    const conn = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('information_schema')) return [[]];
        throw new Error('alter failed');
      }),
      release: vi.fn(),
    };
    const pool = { getConnection: vi.fn().mockResolvedValue(conn) };

    await expect(
      addColumnIfMissingMysql(pool, 'nodes', 'notes', 'notes VARCHAR(2000)'),
    ).rejects.toThrow('alter failed');
    expect(conn.release).toHaveBeenCalled();
  });
});

// ─── createTableIfMissingMysql ────────────────────────────────────────────────

describe('createTableIfMissingMysql', () => {
  const DDL = `CREATE TABLE my_events (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    sourceId VARCHAR(255) NOT NULL,
    timestamp BIGINT NOT NULL,
    INDEX my_events_src_idx (sourceId, timestamp)
  )`;

  it('issues CREATE TABLE when the table is absent', async () => {
    const { pool, conn } = makeMysqlPool([], /* no existing tables */ []);
    await createTableIfMissingMysql(pool, 'my_events', DDL);

    expect(conn.query).toHaveBeenCalledWith(
      expect.stringContaining('information_schema.TABLES'),
      ['my_events'],
    );
    expect(conn.query).toHaveBeenCalledWith(DDL);
    expect(conn.release).toHaveBeenCalled();
  });

  it('skips CREATE TABLE when the table already exists', async () => {
    const { pool, conn } = makeMysqlPool([], ['my_events']);
    await createTableIfMissingMysql(pool, 'my_events', DDL);

    // Only one query: the information_schema check
    expect(conn.query).toHaveBeenCalledTimes(1);
    expect(conn.query).toHaveBeenCalledWith(
      expect.stringContaining('information_schema.TABLES'),
      ['my_events'],
    );
    expect(conn.release).toHaveBeenCalled();
  });

  it('releases the connection even when CREATE TABLE throws', async () => {
    const conn = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('information_schema')) return [[]];
        throw new Error('create failed');
      }),
      release: vi.fn(),
    };
    const pool = { getConnection: vi.fn().mockResolvedValue(conn) };

    await expect(
      createTableIfMissingMysql(pool, 'my_events', DDL),
    ).rejects.toThrow('create failed');
    expect(conn.release).toHaveBeenCalled();
  });
});
