/**
 * Per-source isolation tests for BackupHistoryRepository (#6285)
 *
 * Validates BackupHistoryRepository against SQLite, PostgreSQL, and MySQL backends
 * using the shared test factory from test-utils.ts.
 *
 * SQLite: always runs (in-memory)
 * PostgreSQL: requires test container on port 5433 (skipped if unavailable)
 * MySQL: requires test container on port 3307 (skipped if unavailable)
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from 'vitest';
import { BackupHistoryRepository } from './backupHistory.js';
import {
  TestBackend,
  createPostgresBackend,
  createMysqlBackend,
  clearTable,
  postgresAvailable,
  mysqlAvailable,
} from './test-utils.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';


const POSTGRES_CREATE = `
  DROP TABLE IF EXISTS backup_history CASCADE;
  CREATE TABLE backup_history (
    id SERIAL PRIMARY KEY,
    "nodeId" TEXT,
    "nodeNum" BIGINT,
    filename TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "fileSize" INTEGER,
    "backupType" TEXT NOT NULL,
    timestamp BIGINT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "sourceId" TEXT,
    protocol TEXT NOT NULL DEFAULT 'meshtastic'
  );
  DROP TABLE IF EXISTS sources CASCADE;
  CREATE TABLE sources (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, config TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT TRUE, "displayOrder" INTEGER NOT NULL DEFAULT 0, "createdAt" BIGINT NOT NULL, "updatedAt" BIGINT NOT NULL, "createdBy" INTEGER)

`;

const MYSQL_CREATE = `
  DROP TABLE IF EXISTS backup_history;
  CREATE TABLE backup_history (
    id SERIAL PRIMARY KEY,
    nodeId VARCHAR(32),
    nodeNum BIGINT,
    filename VARCHAR(255) NOT NULL,
    filePath VARCHAR(512) NOT NULL,
    fileSize INT,
    backupType VARCHAR(16) NOT NULL,
    timestamp BIGINT NOT NULL,
    createdAt BIGINT NOT NULL,
    sourceId VARCHAR(36),
    protocol VARCHAR(16) NOT NULL DEFAULT 'meshtastic'
  );
  DROP TABLE IF EXISTS sources;
  CREATE TABLE sources (id VARCHAR(36) PRIMARY KEY, name VARCHAR(255) NOT NULL, type VARCHAR(32) NOT NULL, config TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT TRUE, displayOrder INT NOT NULL DEFAULT 0, createdAt BIGINT NOT NULL, updatedAt BIGINT NOT NULL, createdBy INT)
`;

const ALL_TABLES = ['backup_history', 'sources'];

/**
 * Shared per-source suite. `sources` rows give "owned" vs "orphaned".
 */
function runPerSourceTests(getBackend: () => TestBackend) {
  let repo: BackupHistoryRepository;
  const now = Date.now();
  const row = (sourceId: string | null, filename: string, ts: number, protocol = 'meshtastic') => ({
    sourceId, filename, filePath: `/b/${filename}`, backupType: 'manual', timestamp: ts, createdAt: now, protocol,
  });

  beforeEach(async () => {
    const backend = getBackend();
    if (!backend.available) return;
    repo = new BackupHistoryRepository(backend.drizzleDb, backend.dbType);
    const t = now;
    for (const [id, type] of [['A', 'meshtastic_tcp'], ['B', 'meshcore']]) {
      await backend.drizzleDb.insert((repo as any).tables.sources).values({
        id, name: id, type, config: '{}', enabled: true, displayOrder: 0, createdAt: t, updatedAt: t,
      });
    }
  });

  it('lists, gets, counts and purges only the named source (same filename in two sources)', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }
    await repo.insertBackupHistory(row('A', 'same.yaml', 1));
    await repo.insertBackupHistory(row('A', 'a2.yaml', 2));
    await repo.insertBackupHistory(row('B', 'same.yaml', 3, 'meshcore'));

    expect((await repo.getBackupHistoryList('A')).map(r => r.filename)).toEqual(['a2.yaml', 'same.yaml']);
    expect((await repo.getBackupHistoryList('B')).map(r => r.filename)).toEqual(['same.yaml']);
    expect((await repo.getBackupByFilename('B', 'a2.yaml'))).toBeNull();
    expect((await repo.getBackupByFilename('B', 'same.yaml'))?.protocol).toBe('meshcore');
    expect(await repo.countBackups('A')).toBe(2);
    expect((await repo.getOldestBackups('A', 1)).map(r => r.filename)).toEqual(['same.yaml']);
    expect((await repo.getOldestBackups('B', 5)).map(r => r.sourceId)).toEqual(['B']);

    const victim = await repo.getBackupByFilename('A', 'same.yaml');
    await repo.deleteBackupHistoryById(victim!.id!);
    expect(await repo.countBackups('A')).toBe(1);
    expect(await repo.countBackups('B')).toBe(1); // same filename in B survives
  });

  it('listUnowned returns NULL and orphaned rows only, filtered by protocol', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }
    await repo.insertBackupHistory(row('A', 'owned.yaml', 1));
    await repo.insertBackupHistory(row(null, 'legacy.yaml', 2));
    await repo.insertBackupHistory(row('GONE', 'orphan.yaml', 3));
    await repo.insertBackupHistory(row('GONE', 'orphan-mc.yaml', 4, 'meshcore'));

    expect((await repo.listUnowned()).map(r => r.filename)).toEqual(['orphan-mc.yaml', 'orphan.yaml', 'legacy.yaml']);
    expect((await repo.listUnowned('meshtastic')).map(r => r.filename)).toEqual(['orphan.yaml', 'legacy.yaml']);
    expect((await repo.getUnownedByFilename('legacy.yaml'))?.sourceId ?? null).toBeNull();
    expect(await repo.getUnownedByFilename('owned.yaml')).toBeNull();
  });
}

// --- SQLite Backend ---
describe('BackupHistoryRepository per-source - SQLite Backend', () => {
  let backend: TestBackend;

  beforeEach(() => {
    const t = createTestDb();
    backend = {
      dbType: 'sqlite',
      drizzleDb: t.db,
      exec: async (sql: string) => { t.sqlite.exec(sql); },
      close: async () => { t.close(); },
      available: true,
    };
  });

  afterEach(async () => {
    await backend.close();
  });

  runPerSourceTests(() => backend);
});

// --- PostgreSQL Backend ---
describe.skipIf(!postgresAvailable)('BackupHistoryRepository per-source - PostgreSQL Backend', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE, 'r_backuphistory_ps');
    if (backend.available) {
      console.log('✓ PostgreSQL connection established for backup history tests');
    } else {
      console.log(`⚠ ${backend.skipReason}`);
    }
  });

  afterAll(async () => {
    if (backend) await backend.close();
  });

  beforeEach(async () => {
    if (!backend.available) return;
    for (const table of ALL_TABLES) {
      await clearTable(backend, table);
    }
  });

  runPerSourceTests(() => backend);
});

// --- MySQL Backend ---
describe.skipIf(!mysqlAvailable)('BackupHistoryRepository per-source - MySQL Backend', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE, 'r_backuphistory_ps');
    if (backend.available) {
      console.log('✓ MySQL connection established for backup history tests');
    } else {
      console.log(`⚠ ${backend.skipReason}`);
    }
  });

  afterAll(async () => {
    if (backend) await backend.close();
  });

  beforeEach(async () => {
    if (!backend.available) return;
    for (const table of ALL_TABLES) {
      await clearTable(backend, table);
    }
  });

  runPerSourceTests(() => backend);
});
