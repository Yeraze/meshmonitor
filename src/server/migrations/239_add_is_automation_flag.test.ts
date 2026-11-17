import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { migration, runMigration239Postgres, runMigration239Mysql } from './239_add_is_automation_flag.js';

describe('Migration 239 — add is_automation flag to messages + packet_log', () => {
  it('adds both columns on SQLite, is idempotent, and keeps 0 distinct from NULL', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE messages (id TEXT PRIMARY KEY, text TEXT);
      CREATE TABLE packet_log (id INTEGER PRIMARY KEY AUTOINCREMENT, from_node INTEGER);
      INSERT INTO messages (id, text) VALUES ('m1', 'hi');
      INSERT INTO packet_log (from_node) VALUES (1);
    `);

    migration.up(db);
    migration.up(db);

    const cols = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols('messages')).toContain('isAutomation');
    expect(cols('packet_log')).toContain('is_automation');

    const msg = db.prepare('SELECT isAutomation FROM messages').get() as { isAutomation: number | null };
    expect(msg.isAutomation).toBeNull();
    const pkt = db.prepare('SELECT is_automation FROM packet_log').get() as { is_automation: number | null };
    expect(pkt.is_automation).toBeNull();

    db.prepare('UPDATE packet_log SET is_automation = 0').run();
    const cleared = db.prepare('SELECT is_automation FROM packet_log').get() as { is_automation: number | null };
    expect(cleared.is_automation).toBe(0);
    db.close();
  });

  it('uses ADD COLUMN IF NOT EXISTS on PostgreSQL for both tables', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    await runMigration239Postgres(client);

    expect(client.query).toHaveBeenCalledTimes(2);
    const sqls = client.query.mock.calls.map((c) => c[0] as string);
    expect(sqls[0]).toContain('ADD COLUMN IF NOT EXISTS');
    expect(sqls[0]).toContain('"isAutomation"');
    expect(sqls[1]).toContain('is_automation');
  });

  it('skips ALTER when the MySQL columns already exist', async () => {
    const conn = {
      query: vi.fn().mockResolvedValue([[{ COLUMN_NAME: 'x' }]]),
      release: vi.fn(),
    };
    const pool = { getConnection: vi.fn().mockResolvedValue(conn) };
    await runMigration239Mysql(pool);

    for (const call of conn.query.mock.calls) {
      expect(call[0]).toContain('information_schema.COLUMNS');
    }
  });
});
