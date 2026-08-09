import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { migration, runMigration138Postgres, runMigration138Mysql } from './138_add_conversation_read_state.js';

describe('Migration 138 — conversation_read_state table (#4607)', () => {
  describe('SQLite', () => {
    it('creates the table and is idempotent (second up() does not throw)', () => {
      const db = new Database(':memory:');

      migration.up(db);
      expect(() => migration.up(db)).not.toThrow();

      const table = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name = 'conversation_read_state'`
      ).get();
      expect(table).toBeTruthy();

      const index = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_conversation_read_state_unique'`
      ).get();
      expect(index).toBeTruthy();

      db.close();
    });

    it('enforces one watermark per (user, source, kind, key)', () => {
      const db = new Database(':memory:');
      migration.up(db);

      const insert = db.prepare(`
        INSERT INTO conversation_read_state (user_id, source_id, conversation_kind, conversation_key, last_read_at)
        VALUES (?, ?, ?, ?, ?)
      `);

      insert.run(1, 'src-a', 'meshcore_channel', '0', 1000);

      // Same tuple → rejected by the unique index (this is the upsert's
      // conflict target; without it every write would append a row).
      expect(() => insert.run(1, 'src-a', 'meshcore_channel', '0', 2000)).toThrow();

      // Each of the four discriminators independently makes it a new row.
      expect(() => insert.run(2, 'src-a', 'meshcore_channel', '0', 1000)).not.toThrow();
      expect(() => insert.run(1, 'src-b', 'meshcore_channel', '0', 1000)).not.toThrow();
      expect(() => insert.run(1, 'src-a', 'meshcore_dm', '0', 1000)).not.toThrow();
      expect(() => insert.run(1, 'src-a', 'meshcore_channel', '1', 1000)).not.toThrow();

      db.close();
    });

    it('keeps the anonymous sentinel (user_id 0) distinct from real users', () => {
      // The sentinel exists because a NULLable user_id cannot participate in
      // the unique index — SQLite treats NULLs as distinct, so anonymous
      // writes would append forever instead of updating.
      const db = new Database(':memory:');
      migration.up(db);

      const insert = db.prepare(`
        INSERT INTO conversation_read_state (user_id, source_id, conversation_kind, conversation_key, last_read_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      insert.run(0, 'src-a', 'meshcore_channel', '0', 1000);
      expect(() => insert.run(0, 'src-a', 'meshcore_channel', '0', 2000)).toThrow();
      expect(() => insert.run(7, 'src-a', 'meshcore_channel', '0', 2000)).not.toThrow();

      const rows = db.prepare(`SELECT user_id FROM conversation_read_state ORDER BY user_id`).all() as any[];
      expect(rows.map(r => r.user_id)).toEqual([0, 7]);

      db.close();
    });
  });

  describe('PostgreSQL', () => {
    it('creates the table and unique index with quoted camelCase columns', async () => {
      const client = { query: vi.fn().mockResolvedValue({ rows: [] }) } as any;

      await runMigration138Postgres(client);

      expect(client.query).toHaveBeenCalledTimes(2);
      const ddl = client.query.mock.calls[0][0];
      expect(ddl).toContain('CREATE TABLE IF NOT EXISTS conversation_read_state');
      expect(ddl).toContain('"userId" INTEGER NOT NULL');
      expect(ddl).toContain('"sourceId" TEXT NOT NULL');
      expect(ddl).toContain('"conversationKind" TEXT NOT NULL');
      expect(ddl).toContain('"conversationKey" TEXT NOT NULL');
      expect(ddl).toContain('"lastReadAt" BIGINT NOT NULL');

      const idx = client.query.mock.calls[1][0];
      expect(idx).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_read_state_unique');
      expect(idx).toContain('"userId", "sourceId", "conversationKind", "conversationKey"');
    });

    it('is idempotent (running twice does not throw)', async () => {
      const client = { query: vi.fn().mockResolvedValue({ rows: [] }) } as any;
      await runMigration138Postgres(client);
      await expect(runMigration138Postgres(client)).resolves.not.toThrow();
    });
  });

  describe('MySQL', () => {
    function makeConn(existRows: any[]) {
      return {
        query: vi.fn().mockResolvedValue([existRows, []]),
        release: vi.fn(),
      };
    }

    it('creates the table with an inline UNIQUE KEY when absent, then skips', async () => {
      const absentConn = makeConn([]);
      const absentPool = { getConnection: vi.fn().mockResolvedValue(absentConn) };

      await runMigration138Mysql(absentPool as any);

      expect(absentConn.query).toHaveBeenCalledTimes(2);
      const ddl = absentConn.query.mock.calls[1][0];
      expect(ddl).toContain('CREATE TABLE conversation_read_state');
      // MySQL has no CREATE INDEX IF NOT EXISTS, so the key must be inline or
      // a re-run after a crash would fail.
      expect(ddl).toContain('UNIQUE KEY idx_conversation_read_state_unique (userId, sourceId, conversationKind, conversationKey)');
      expect(absentConn.release).toHaveBeenCalledTimes(1);

      const presentConn = makeConn([{ TABLE_NAME: 'conversation_read_state' }]);
      const presentPool = { getConnection: vi.fn().mockResolvedValue(presentConn) };

      await runMigration138Mysql(presentPool as any);

      expect(presentConn.query).toHaveBeenCalledTimes(1); // existence check only
      expect(presentConn.release).toHaveBeenCalledTimes(1);
    });
  });
});
