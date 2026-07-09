/**
 * Multi-Database Upgrade History Repository Tests
 *
 * Validates UpgradeHistoryRepository against SQLite, PostgreSQL, and MySQL backends
 * using the shared test factory from test-utils.ts.
 *
 * SQLite: always runs (in-memory)
 * PostgreSQL: requires test container on port 5433 (skipped if unavailable)
 * MySQL: requires test container on port 3307 (skipped if unavailable)
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from 'vitest';
import { UpgradeHistoryRepository } from './upgradeHistory.js';
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
  DROP TABLE IF EXISTS upgrade_history CASCADE;
  CREATE TABLE upgrade_history (
    id TEXT PRIMARY KEY,
    "fromVersion" TEXT NOT NULL,
    "toVersion" TEXT NOT NULL,
    "deploymentMethod" TEXT NOT NULL,
    status TEXT NOT NULL,
    progress INTEGER DEFAULT 0,
    "currentStep" TEXT,
    logs TEXT,
    "backupPath" TEXT,
    "startedAt" BIGINT,
    "completedAt" BIGINT,
    "initiatedBy" TEXT,
    "errorMessage" TEXT,
    "rollbackAvailable" BOOLEAN
  )
`;

const MYSQL_CREATE = `
  DROP TABLE IF EXISTS upgrade_history;
  CREATE TABLE upgrade_history (
    id VARCHAR(64) PRIMARY KEY,
    fromVersion VARCHAR(32) NOT NULL,
    toVersion VARCHAR(32) NOT NULL,
    deploymentMethod VARCHAR(32) NOT NULL,
    status VARCHAR(32) NOT NULL,
    progress INT DEFAULT 0,
    currentStep VARCHAR(255),
    logs TEXT,
    backupPath VARCHAR(512),
    startedAt BIGINT,
    completedAt BIGINT,
    initiatedBy VARCHAR(64),
    errorMessage TEXT,
    rollbackAvailable BOOLEAN
  )
`;

const ALL_TABLES = ['upgrade_history'];

/**
 * Shared test suite that runs against any backend.
 */
function runUpgradeHistoryTests(getBackend: () => TestBackend) {
  let repo: UpgradeHistoryRepository;

  beforeEach(async () => {
    const backend = getBackend();
    if (!backend.available) return;
    repo = new UpgradeHistoryRepository(backend.drizzleDb, backend.dbType);
  });

  // ============ UPGRADE HISTORY ============

  it('createUpgradeHistory and getUpgradeById - create and retrieve', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const now = Date.now();
    await repo.createUpgradeHistory({
      id: 'upgrade-001',
      fromVersion: '3.7.0',
      toVersion: '3.8.0',
      deploymentMethod: 'docker',
      status: 'complete',
      startedAt: now,
    });

    const record = await repo.getUpgradeById('upgrade-001');
    expect(record).not.toBeNull();
    expect(record!.id).toBe('upgrade-001');
    expect(record!.fromVersion).toBe('3.7.0');
    expect(record!.toVersion).toBe('3.8.0');
    expect(record!.status).toBe('complete');
  });

  it('getUpgradeById - returns null for missing record', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const result = await repo.getUpgradeById('nonexistent-id');
    expect(result).toBeNull();
  });

  it('getUpgradeHistoryList and getLastUpgrade - ordered list', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const base = Date.now();
    await repo.createUpgradeHistory({ id: 'u1', fromVersion: '1.0', toVersion: '1.1', deploymentMethod: 'docker', status: 'complete', startedAt: base });
    await repo.createUpgradeHistory({ id: 'u2', fromVersion: '1.1', toVersion: '1.2', deploymentMethod: 'docker', status: 'complete', startedAt: base + 1000 });

    const list = await repo.getUpgradeHistoryList();
    expect(list).toHaveLength(2);
    // Most recent first
    expect(list[0].id).toBe('u2');

    const last = await repo.getLastUpgrade();
    expect(last!.id).toBe('u2');
  });

  it('markUpgradeFailed - updates status and errorMessage', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    await repo.createUpgradeHistory({ id: 'u1', fromVersion: '1.0', toVersion: '1.1', deploymentMethod: 'docker', status: 'pending', startedAt: Date.now() });
    await repo.markUpgradeFailed('u1', 'Container failed to start');

    const record = await repo.getUpgradeById('u1');
    expect(record!.status).toBe('failed');
    expect(record!.errorMessage).toBe('Container failed to start');
  });

  it('markUpgradeComplete - updates status', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    await repo.createUpgradeHistory({ id: 'u1', fromVersion: '1.0', toVersion: '1.1', deploymentMethod: 'docker', status: 'restarting', startedAt: Date.now() });
    await repo.markUpgradeComplete('u1');

    const record = await repo.getUpgradeById('u1');
    expect(record!.status).toBe('complete');
  });

  it('findStaleUpgrades - finds upgrades older than threshold', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const old = Date.now() - 60 * 60 * 1000; // 1 hour ago
    const recent = Date.now() - 100; // very recent

    await repo.createUpgradeHistory({ id: 'old-upgrade', fromVersion: '1.0', toVersion: '1.1', deploymentMethod: 'docker', status: 'pending', startedAt: old });
    await repo.createUpgradeHistory({ id: 'recent-upgrade', fromVersion: '1.1', toVersion: '1.2', deploymentMethod: 'docker', status: 'pending', startedAt: recent });

    const threshold = Date.now() - 30 * 60 * 1000; // stale after 30min
    const stale = await repo.findStaleUpgrades(threshold);
    expect(stale.some(u => u.id === 'old-upgrade')).toBe(true);
    expect(stale.some(u => u.id === 'recent-upgrade')).toBe(false);
  });

  it('countInProgressUpgrades - counts non-stale in-progress', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const recent = Date.now() - 100;
    await repo.createUpgradeHistory({ id: 'u1', fromVersion: '1.0', toVersion: '1.1', deploymentMethod: 'docker', status: 'pending', startedAt: recent });
    await repo.createUpgradeHistory({ id: 'u2', fromVersion: '1.1', toVersion: '1.2', deploymentMethod: 'docker', status: 'complete', startedAt: recent });

    const threshold = Date.now() - 30 * 60 * 1000;
    const count = await repo.countInProgressUpgrades(threshold);
    expect(count).toBe(1); // only 'pending' is an in-progress status
  });

  it('countConsecutiveFailedUpgrades - returns 0 with no history', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const count = await repo.countConsecutiveFailedUpgrades();
    expect(count).toBe(0);
  });

  it('countConsecutiveFailedUpgrades - counts run of failures from most recent', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const base = Date.now();
    await repo.createUpgradeHistory({ id: 'u1', fromVersion: '1.0', toVersion: '1.1', deploymentMethod: 'docker', status: 'failed', startedAt: base });
    await repo.createUpgradeHistory({ id: 'u2', fromVersion: '1.0', toVersion: '1.1', deploymentMethod: 'docker', status: 'failed', startedAt: base + 1000 });
    await repo.createUpgradeHistory({ id: 'u3', fromVersion: '1.0', toVersion: '1.1', deploymentMethod: 'docker', status: 'failed', startedAt: base + 2000 });

    const count = await repo.countConsecutiveFailedUpgrades();
    expect(count).toBe(3);
  });

  it('countConsecutiveFailedUpgrades - stops at first non-failed row', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const base = Date.now();
    // Older completed run, then 2 recent failures
    await repo.createUpgradeHistory({ id: 'u1', fromVersion: '1.0', toVersion: '1.1', deploymentMethod: 'docker', status: 'failed', startedAt: base });
    await repo.createUpgradeHistory({ id: 'u2', fromVersion: '1.0', toVersion: '1.1', deploymentMethod: 'docker', status: 'complete', startedAt: base + 1000 });
    await repo.createUpgradeHistory({ id: 'u3', fromVersion: '1.0', toVersion: '1.1', deploymentMethod: 'docker', status: 'failed', startedAt: base + 2000 });
    await repo.createUpgradeHistory({ id: 'u4', fromVersion: '1.0', toVersion: '1.1', deploymentMethod: 'docker', status: 'failed', startedAt: base + 3000 });

    const count = await repo.countConsecutiveFailedUpgrades();
    expect(count).toBe(2);
  });

  it('countConsecutiveFailedUpgrades - returns 0 when most recent succeeded', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const base = Date.now();
    await repo.createUpgradeHistory({ id: 'u1', fromVersion: '1.0', toVersion: '1.1', deploymentMethod: 'docker', status: 'failed', startedAt: base });
    await repo.createUpgradeHistory({ id: 'u2', fromVersion: '1.0', toVersion: '1.1', deploymentMethod: 'docker', status: 'complete', startedAt: base + 1000 });

    const count = await repo.countConsecutiveFailedUpgrades();
    expect(count).toBe(0);
  });
}

// --- SQLite Backend ---
describe('UpgradeHistoryRepository - SQLite Backend', () => {
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

  runUpgradeHistoryTests(() => backend);
});

// --- PostgreSQL Backend ---
describe.skipIf(!postgresAvailable)('UpgradeHistoryRepository - PostgreSQL Backend', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE);
    if (backend.available) {
      console.log('✓ PostgreSQL connection established for upgrade history tests');
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

  runUpgradeHistoryTests(() => backend);
});

// --- MySQL Backend ---
describe.skipIf(!mysqlAvailable)('UpgradeHistoryRepository - MySQL Backend', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE);
    if (backend.available) {
      console.log('✓ MySQL connection established for upgrade history tests');
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

  runUpgradeHistoryTests(() => backend);
});
