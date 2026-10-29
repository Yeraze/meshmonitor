/**
 * AutomationFireStateRepository across SQLite / PostgreSQL / MySQL.
 *
 * The DDL below mirrors migration 219. PG/MySQL suites own a private database
 * via `isolationKey` (CLAUDE.md Multi-Database: never share fixture tables).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { AutomationFireStateRepository } from './automationFireState.js';
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
  CREATE TABLE automation_fire_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    automationId TEXT NOT NULL,
    kind TEXT NOT NULL,
    scopeKey TEXT NOT NULL,
    firedAt INTEGER NOT NULL,
    events TEXT
  );
  CREATE UNIQUE INDEX afs_automation_kind_key_idx ON automation_fire_state(automationId, kind, scopeKey);
`;

const POSTGRES_CREATE = `
  DROP TABLE IF EXISTS automation_fire_state CASCADE;
  CREATE TABLE automation_fire_state (
    id SERIAL PRIMARY KEY,
    "automationId" TEXT NOT NULL,
    kind TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "firedAt" BIGINT NOT NULL,
    events TEXT
  );
  CREATE UNIQUE INDEX afs_automation_kind_key_idx ON automation_fire_state("automationId", kind, "scopeKey");
`;

const MYSQL_CREATE = `
  CREATE TABLE automation_fire_state (
    id INT AUTO_INCREMENT PRIMARY KEY,
    automationId VARCHAR(36) NOT NULL,
    kind VARCHAR(16) NOT NULL,
    scopeKey VARCHAR(191) NOT NULL,
    firedAt BIGINT NOT NULL,
    events TEXT,
    UNIQUE KEY afs_automation_kind_key_idx (automationId, kind, scopeKey)
  );
`;

const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';
/** Above 2^32 ms, so a 32-bit column would truncate it. */
const T = 1_790_000_000_000;

function runSuite(name: string, makeBackend: () => Promise<TestBackend>, skip: boolean) {
  describe.skipIf(skip)(`AutomationFireStateRepository (${name})`, () => {
    let backend: TestBackend;
    let repo: AutomationFireStateRepository;

    beforeAll(async () => {
      backend = await makeBackend();
      repo = new AutomationFireStateRepository(backend.drizzleDb, backend.dbType);
    });
    afterAll(async () => {
      await backend.close();
    });
    beforeEach(async () => {
      await clearTable(backend, 'automation_fire_state');
    });

    const sorted = async () =>
      (await repo.listAll()).sort((x, y) => (x.automationId + x.kind + x.scopeKey).localeCompare(y.automationId + y.kind + y.scopeKey));

    it('upserts a cooldown key in place', async () => {
      await repo.upsertCooldown(A, 'src:!abcd', T);
      await repo.upsertCooldown(A, 'src:!abcd', T + 5);
      await repo.upsertCooldown(A, '', T);
      expect(await sorted()).toEqual([
        { automationId: A, kind: 'cooldown', scopeKey: '', firedAt: T, events: null },
        { automationId: A, kind: 'cooldown', scopeKey: 'src:!abcd', firedAt: T + 5, events: null },
      ]);
    });

    it('upserts the rate window; an empty window deletes it', async () => {
      await repo.upsertRateEvents(A, [T, T + 1]);
      await repo.upsertRateEvents(A, [T + 1, T + 2]);
      expect(await repo.listAll()).toEqual([
        { automationId: A, kind: 'rate', scopeKey: '', firedAt: T + 2, events: [T + 1, T + 2] },
      ]);
      await repo.upsertRateEvents(A, []);
      expect(await repo.listAll()).toEqual([]);
    });

    it('a rate row and an automation-wide cooldown row coexist (kind is part of the key)', async () => {
      await repo.upsertCooldown(A, '', T);
      await repo.upsertRateEvents(A, [T]);
      expect((await repo.listAll()).map((r) => r.kind).sort()).toEqual(['cooldown', 'rate']);
    });

    it('deleteCooldownsBefore removes only older cooldown rows of that automation', async () => {
      await repo.upsertCooldown(A, 'n1', T);
      await repo.upsertCooldown(A, 'n2', T + 10);
      await repo.upsertCooldown(B, 'n1', T);
      await repo.upsertRateEvents(A, [T]);
      await repo.deleteCooldownsBefore(A, T + 10);
      expect((await sorted()).map((r) => `${r.automationId === A ? 'A' : 'B'}:${r.kind}:${r.scopeKey}`)).toEqual([
        'A:cooldown:n2', 'A:rate:', 'B:cooldown:n1',
      ]);
    });

    it('deleteKind and deleteByAutomation are scoped to one automation', async () => {
      await repo.upsertCooldown(A, 'n1', T);
      await repo.upsertRateEvents(A, [T]);
      await repo.upsertCooldown(B, 'n1', T);
      await repo.deleteKind(A, 'cooldown');
      expect((await repo.listByAutomation(A)).map((r) => r.kind)).toEqual(['rate']);
      await repo.deleteByAutomation(A);
      expect(await repo.listByAutomation(A)).toEqual([]);
      expect(await repo.listByAutomation(B)).toHaveLength(1);
    });

    it('reads malformed events as an empty window', async () => {
      await repo.upsertRateEvents(A, [T]);
      await backend.exec(`UPDATE automation_fire_state SET events = 'not json'`);
      expect((await repo.listAll())[0].events).toEqual([]);
    });
  });
}

runSuite('sqlite', async () => createSqliteBackend(SQLITE_CREATE), false);
runSuite('postgres', () => createPostgresBackend(POSTGRES_CREATE, 'afs'), !postgresAvailable);
runSuite('mysql', () => createMysqlBackend(MYSQL_CREATE, 'afs'), !mysqlAvailable);
