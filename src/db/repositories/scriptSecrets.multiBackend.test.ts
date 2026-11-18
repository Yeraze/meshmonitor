/**
 * ScriptSecretsRepository across SQLite / PostgreSQL / MySQL.
 *
 * The DDL below mirrors migration 240. PG/MySQL suites own a private database
 * via `isolationKey` (CLAUDE.md Multi-Database: never share fixture tables).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ScriptSecretsRepository } from './scriptSecrets.js';
import {
  createSqliteBackend,
  createPostgresBackend,
  createMysqlBackend,
  clearTable,
  postgresAvailable,
  mysqlAvailable,
  type TestBackend,
} from './test-utils.js';

const SQLITE_CREATE = `
  CREATE TABLE script_secrets (
    name TEXT PRIMARY KEY,
    encryptedValue TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  );
`;

const POSTGRES_CREATE = `
  DROP TABLE IF EXISTS script_secrets CASCADE;
  CREATE TABLE script_secrets (
    "name" TEXT PRIMARY KEY,
    "encryptedValue" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL
  );
`;

const MYSQL_CREATE = `
  CREATE TABLE script_secrets (
    name VARCHAR(64) PRIMARY KEY,
    encryptedValue TEXT NOT NULL,
    createdAt BIGINT NOT NULL,
    updatedAt BIGINT NOT NULL
  );
`;

function runSuite(name: string, makeBackend: () => Promise<TestBackend>, skip: boolean) {
  describe.skipIf(skip)(`ScriptSecretsRepository (${name})`, () => {
    let backend: TestBackend;
    let repo: ScriptSecretsRepository;

    beforeAll(async () => {
      backend = await makeBackend();
      repo = new ScriptSecretsRepository(backend.drizzleDb, backend.dbType);
    });
    afterAll(async () => {
      await backend.close();
    });
    beforeEach(async () => {
      await clearTable(backend, 'script_secrets');
    });

    it('inserts, then updates in place', async () => {
      const first = await repo.upsert('API_KEY', '{"v":1}');
      expect(first.created).toBe(true);
      const second = await repo.upsert('API_KEY', '{"v":2}');
      expect(second.created).toBe(false);
      const rows = await repo.getAll();
      expect(rows).toHaveLength(1);
      expect(rows[0].encryptedValue).toBe('{"v":2}');
      expect(typeof rows[0].updatedAt).toBe('number');
      expect(rows[0].updatedAt).toBeGreaterThanOrEqual(rows[0].createdAt);
    });

    it('lists metadata without the envelope, sorted by name', async () => {
      await repo.upsert('ZED', 'x');
      await repo.upsert('ALPHA', 'y');
      const meta = await repo.listMetadata();
      expect(meta.map((m) => m.name)).toEqual(['ALPHA', 'ZED']);
      for (const m of meta) expect(Object.keys(m).sort()).toEqual(['name', 'updatedAt']);
    });

    it('counts, checks existence and deletes', async () => {
      expect(await repo.count()).toBe(0);
      await repo.upsert('A', 'x');
      await repo.upsert('B', 'y');
      expect(await repo.count()).toBe(2);
      expect(await repo.exists('A')).toBe(true);
      expect(await repo.delete('A')).toBe(true);
      expect(await repo.delete('A')).toBe(false);
      expect(await repo.exists('A')).toBe(false);
      expect(await repo.count()).toBe(1);
    });
  });
}

runSuite('sqlite', async () => createSqliteBackend(SQLITE_CREATE), false);
runSuite('postgres', () => createPostgresBackend(POSTGRES_CREATE, 'script_secrets'), !postgresAvailable);
runSuite('mysql', () => createMysqlBackend(MYSQL_CREATE, 'script_secrets'), !mysqlAvailable);
