import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { migration, runMigration136Postgres, runMigration136Mysql } from './136_add_meshcore_observer_credentials.js';

describe('Migration 136 — meshcore_observer_credentials table', () => {
  describe('SQLite', () => {
    it('creates the table and is idempotent (second up() does not throw)', () => {
      const db = new Database(':memory:');

      migration.up(db);
      expect(() => migration.up(db)).not.toThrow();

      const table = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name = 'meshcore_observer_credentials'`
      ).get();
      expect(table).toBeTruthy();

      db.close();
    });

    it('round-trips a full row insert/read through the migrated schema', () => {
      const db = new Database(':memory:');
      migration.up(db);

      const now = Date.now();
      db.prepare(`
        INSERT INTO meshcore_observer_credentials (
          sourceId, username, encryptedPassword, createdAt, updatedAt
        ) VALUES (@sourceId, @username, @encryptedPassword, @createdAt, @updatedAt)
      `).run({
        sourceId: 'source-a',
        username: 'meshcore',
        encryptedPassword: JSON.stringify({ v: 1, kid: 'abc123', iv: 'iv', ct: 'ct', tag: 'tag' }),
        createdAt: now,
        updatedAt: now,
      });

      const row = db.prepare(
        `SELECT * FROM meshcore_observer_credentials WHERE sourceId = 'source-a'`,
      ).get() as any;
      expect(row).toBeTruthy();
      expect(row.username).toBe('meshcore');
      expect(JSON.parse(row.encryptedPassword).v).toBe(1);

      // Primary key — inserting the same sourceId again must fail.
      expect(() => db.prepare(`
        INSERT INTO meshcore_observer_credentials (sourceId, username, encryptedPassword, createdAt, updatedAt)
        VALUES ('source-a', 'u', 'x', @createdAt, @updatedAt)
      `).run({ createdAt: now, updatedAt: now })).toThrow();

      // A different sourceId is allowed (per-source scope).
      expect(() => db.prepare(`
        INSERT INTO meshcore_observer_credentials (sourceId, username, encryptedPassword, createdAt, updatedAt)
        VALUES ('source-b', 'u', 'x', @createdAt, @updatedAt)
      `).run({ createdAt: now, updatedAt: now })).not.toThrow();

      db.close();
    });
  });

  describe('PostgreSQL', () => {
    it('creates the table with IF NOT EXISTS and quoted camelCase columns', async () => {
      const client = { query: vi.fn().mockResolvedValue({ rows: [] }) } as any;

      await runMigration136Postgres(client);

      expect(client.query).toHaveBeenCalledTimes(1);
      const ddl = client.query.mock.calls[0][0];
      expect(ddl).toContain('CREATE TABLE IF NOT EXISTS meshcore_observer_credentials');
      expect(ddl).toContain('"sourceId" TEXT PRIMARY KEY');
      expect(ddl).toContain('"username" TEXT NOT NULL');
      expect(ddl).toContain('"encryptedPassword" TEXT NOT NULL');
      expect(ddl).toContain('"createdAt" BIGINT NOT NULL');
      expect(ddl).toContain('"updatedAt" BIGINT NOT NULL');
    });

    it('is idempotent (running twice does not throw)', async () => {
      const client = { query: vi.fn().mockResolvedValue({ rows: [] }) } as any;
      await runMigration136Postgres(client);
      await expect(runMigration136Postgres(client)).resolves.not.toThrow();
    });
  });

  describe('MySQL', () => {
    function makeConn(existRows: any[]) {
      return {
        query: vi.fn().mockResolvedValue([existRows, []]),
        release: vi.fn(),
      };
    }

    it('creates the table when absent, then skips create when present', async () => {
      const absentConn = makeConn([]);
      const absentPool = { getConnection: vi.fn().mockResolvedValue(absentConn) };

      await runMigration136Mysql(absentPool as any);

      expect(absentConn.query).toHaveBeenCalledTimes(2);
      expect(absentConn.query.mock.calls[1][0]).toContain('CREATE TABLE meshcore_observer_credentials');
      expect(absentConn.query.mock.calls[1][0]).toContain('sourceId VARCHAR(36) PRIMARY KEY');
      expect(absentConn.release).toHaveBeenCalledTimes(1);

      const presentConn = makeConn([{ TABLE_NAME: 'meshcore_observer_credentials' }]);
      const presentPool = { getConnection: vi.fn().mockResolvedValue(presentConn) };

      await runMigration136Mysql(presentPool as any);

      expect(presentConn.query).toHaveBeenCalledTimes(1); // only the existence check
      expect(presentConn.release).toHaveBeenCalledTimes(1);
    });
  });
});
