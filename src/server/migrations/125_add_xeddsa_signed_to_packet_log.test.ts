import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { migration, runMigration125Postgres, runMigration125Mysql } from './125_add_xeddsa_signed_to_packet_log.js';

describe('Migration 125 — add xeddsa_signed to packet_log', () => {
  it('adds the column on SQLite and is idempotent', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE packet_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER,
        from_node INTEGER
      );
      INSERT INTO packet_log (timestamp, from_node) VALUES (1000, 1);
    `);

    // Running twice must not throw (idempotent).
    migration.up(db);
    migration.up(db);

    const cols = (db.prepare('PRAGMA table_info(packet_log)').all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(cols).toContain('xeddsa_signed');

    // Existing rows stay NULL (= unknown; pre-2.8 packets carry no flag).
    const row = db.prepare('SELECT xeddsa_signed FROM packet_log WHERE from_node = 1').get() as {
      xeddsa_signed: number | null;
    };
    expect(row.xeddsa_signed).toBeNull();

    // The column accepts both boolean values — 0 (explicitly unsigned) must
    // remain distinguishable from NULL (unknown).
    db.prepare('UPDATE packet_log SET xeddsa_signed = 1 WHERE from_node = 1').run();
    const updated = db.prepare('SELECT xeddsa_signed FROM packet_log WHERE from_node = 1').get() as {
      xeddsa_signed: number | null;
    };
    expect(updated.xeddsa_signed).toBe(1);

    db.prepare('UPDATE packet_log SET xeddsa_signed = 0 WHERE from_node = 1').run();
    const cleared = db.prepare('SELECT xeddsa_signed FROM packet_log WHERE from_node = 1').get() as {
      xeddsa_signed: number | null;
    };
    expect(cleared.xeddsa_signed).toBe(0);
    db.close();
  });

  it('uses ADD COLUMN IF NOT EXISTS on PostgreSQL', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    await runMigration125Postgres(client as unknown as import('pg').PoolClient);

    expect(client.query).toHaveBeenCalledTimes(1);
    const sql = client.query.mock.calls[0][0] as string;
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS');
    expect(sql).toContain('xeddsa_signed');
  });

  it('pre-checks information_schema before ALTER on MySQL', async () => {
    const conn = {
      query: vi.fn()
        // information_schema pre-check: column absent
        .mockResolvedValueOnce([[]])
        // ALTER TABLE
        .mockResolvedValueOnce([{}]),
      release: vi.fn(),
    };
    const pool = { getConnection: vi.fn().mockResolvedValue(conn) };
    await runMigration125Mysql(pool);

    expect(conn.query.mock.calls[0][0]).toContain('information_schema.COLUMNS');
    expect(conn.query.mock.calls[1][0]).toContain('ALTER TABLE packet_log ADD COLUMN');
    expect(conn.release).toHaveBeenCalled();
  });

  it('skips ALTER when the MySQL column already exists', async () => {
    const conn = {
      query: vi.fn().mockResolvedValueOnce([[{ COLUMN_NAME: 'xeddsa_signed' }]]),
      release: vi.fn(),
    };
    const pool = { getConnection: vi.fn().mockResolvedValue(conn) };
    await runMigration125Mysql(pool);

    expect(conn.query).toHaveBeenCalledTimes(1);
    expect(conn.release).toHaveBeenCalled();
  });
});
