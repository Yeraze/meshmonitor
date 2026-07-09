/**
 * Multi-Database Backup History Repository Tests
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
    "createdAt" BIGINT NOT NULL
  )
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
    createdAt BIGINT NOT NULL
  )
`;

const ALL_TABLES = ['backup_history'];

/**
 * Shared test suite that runs against any backend.
 */
function runBackupHistoryTests(getBackend: () => TestBackend) {
  let repo: BackupHistoryRepository;

  beforeEach(async () => {
    const backend = getBackend();
    if (!backend.available) return;
    repo = new BackupHistoryRepository(backend.drizzleDb, backend.dbType);
  });

  // ============ BACKUP HISTORY ============

  it('insertBackupHistory and getBackupHistoryList - insert and retrieve', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const now = Date.now();
    await repo.insertBackupHistory({
      nodeId: '!abcd1234',
      nodeNum: 12345,
      filename: 'backup_2024.json',
      filePath: '/backups/backup_2024.json',
      fileSize: 1024,
      backupType: 'auto',
      timestamp: now,
      createdAt: now,
    });

    const list = await repo.getBackupHistoryList();
    expect(list).toHaveLength(1);
    expect(list[0].filename).toBe('backup_2024.json');
    expect(list[0].backupType).toBe('auto');
  });

  it('getBackupHistoryList - returns empty list initially', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const list = await repo.getBackupHistoryList();
    expect(list).toHaveLength(0);
  });

  it('getBackupHistoryList - ordered by timestamp desc', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const base = Date.now();
    await repo.insertBackupHistory({ filename: 'old.json', filePath: '/old.json', backupType: 'manual', timestamp: base - 2000, createdAt: base });
    await repo.insertBackupHistory({ filename: 'new.json', filePath: '/new.json', backupType: 'auto', timestamp: base, createdAt: base });

    const list = await repo.getBackupHistoryList();
    expect(list[0].filename).toBe('new.json');
    expect(list[1].filename).toBe('old.json');
  });
}

// --- SQLite Backend ---
describe('BackupHistoryRepository - SQLite Backend', () => {
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

  runBackupHistoryTests(() => backend);
});

// --- PostgreSQL Backend ---
describe.skipIf(!postgresAvailable)('BackupHistoryRepository - PostgreSQL Backend', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE);
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

  runBackupHistoryTests(() => backend);
});

// --- MySQL Backend ---
describe.skipIf(!mysqlAvailable)('BackupHistoryRepository - MySQL Backend', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE);
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

  runBackupHistoryTests(() => backend);
});
