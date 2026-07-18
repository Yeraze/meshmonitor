import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { migration, runMigration124Postgres, runMigration124Mysql } from './124_add_position_location_source.js';

describe('Migration 124 — add positionLocationSource to nodes', () => {
  it('adds the column on SQLite and is idempotent', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE nodes (
        nodeNum INTEGER,
        nodeId TEXT,
        sourceId TEXT
      );
      INSERT INTO nodes (nodeNum, nodeId, sourceId) VALUES (1, '!00000001', 'default');
    `);

    // Running twice must not throw (idempotent).
    migration.up(db);
    migration.up(db);

    const cols = (db.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(cols).toContain('positionLocationSource');

    // Existing rows keep NULL (unknown / hidden) — no backfill.
    const row = db.prepare('SELECT positionLocationSource FROM nodes WHERE nodeNum = 1').get() as {
      positionLocationSource: number | null;
    };
    expect(row.positionLocationSource).toBeNull();

    // The column accepts the enum values.
    db.prepare('UPDATE nodes SET positionLocationSource = 2 WHERE nodeNum = 1').run();
    const updated = db.prepare('SELECT positionLocationSource FROM nodes WHERE nodeNum = 1').get() as {
      positionLocationSource: number | null;
    };
    expect(updated.positionLocationSource).toBe(2);
    db.close();
  });

  it('uses ADD COLUMN IF NOT EXISTS on PostgreSQL', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    await runMigration124Postgres(client as unknown as import('pg').PoolClient);

    expect(client.query).toHaveBeenCalledTimes(1);
    const sql = client.query.mock.calls[0][0] as string;
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS');
    expect(sql).toContain('positionLocationSource');
  });

  it('pre-checks information_schema before ALTER on MySQL', async () => {
    const conn = { query: vi.fn(), release: vi.fn() };
    conn.query
      .mockResolvedValueOnce([[], []]) // column absent
      .mockResolvedValueOnce([{}, []]); // ALTER TABLE
    const pool = { getConnection: vi.fn().mockResolvedValue(conn) };

    await runMigration124Mysql(pool as unknown as import('mysql2/promise').Pool);

    expect(conn.query).toHaveBeenCalledTimes(2);
    expect(conn.query.mock.calls[0][0]).toContain('information_schema.COLUMNS');
    expect(conn.query.mock.calls[1][0]).toContain('ADD COLUMN positionLocationSource');
    expect(conn.release).toHaveBeenCalled();
  });
});
