/**
 * Multi-Database Misc Repository Tests
 *
 * Validates MiscRepository against SQLite, PostgreSQL, and MySQL backends
 * using the shared test factory from test-utils.ts.
 *
 * SQLite: always runs (in-memory)
 * PostgreSQL: requires test container on port 5433 (skipped if unavailable)
 * MySQL: requires test container on port 3307 (skipped if unavailable)
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from 'vitest';
import * as schema from '../schema/index.js';
import { MiscRepository } from './misc.js';
import {
  TestBackend,
  createSqliteBackend,
  createPostgresBackend,
  createMysqlBackend,
  clearTable,
  postgresAvailable,
  mysqlAvailable,
} from './test-utils.js';

// SQL for creating all misc tables (no FK constraints in tests)
// Note: solar_estimates uses snake_case column names across all backends
const SQLITE_CREATE = `
  CREATE TABLE IF NOT EXISTS solar_estimates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL UNIQUE,
    watt_hours REAL NOT NULL,
    fetched_at INTEGER NOT NULL,
    created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS auto_traceroute_nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nodeNum INTEGER NOT NULL,
    enabled INTEGER DEFAULT 1,
    createdAt INTEGER NOT NULL,
    sourceId TEXT,
    UNIQUE(nodeNum, sourceId)
  );
  CREATE TABLE IF NOT EXISTS upgrade_history (
    id TEXT PRIMARY KEY,
    fromVersion TEXT NOT NULL,
    toVersion TEXT NOT NULL,
    deploymentMethod TEXT NOT NULL,
    status TEXT NOT NULL,
    progress INTEGER DEFAULT 0,
    currentStep TEXT,
    logs TEXT,
    backupPath TEXT,
    startedAt INTEGER,
    completedAt INTEGER,
    initiatedBy TEXT,
    errorMessage TEXT,
    rollbackAvailable INTEGER
  );
  CREATE TABLE IF NOT EXISTS news_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feedData TEXT NOT NULL,
    fetchedAt INTEGER NOT NULL,
    sourceUrl TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS user_news_status (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL,
    lastSeenNewsId TEXT,
    dismissedNewsIds TEXT,
    updatedAt INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS backup_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nodeId TEXT,
    nodeNum INTEGER,
    filename TEXT NOT NULL,
    filePath TEXT NOT NULL,
    fileSize INTEGER,
    backupType TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    createdAt INTEGER NOT NULL
  )
`;

const POSTGRES_CREATE = `
  DROP TABLE IF EXISTS solar_estimates CASCADE;
  DROP TABLE IF EXISTS auto_traceroute_nodes CASCADE;
  DROP TABLE IF EXISTS upgrade_history CASCADE;
  DROP TABLE IF EXISTS news_cache CASCADE;
  DROP TABLE IF EXISTS user_news_status CASCADE;
  DROP TABLE IF EXISTS backup_history CASCADE;
  CREATE TABLE solar_estimates (
    id SERIAL PRIMARY KEY,
    timestamp BIGINT NOT NULL UNIQUE,
    watt_hours DOUBLE PRECISION NOT NULL,
    fetched_at BIGINT NOT NULL,
    created_at BIGINT
  );
  CREATE TABLE auto_traceroute_nodes (
    id SERIAL PRIMARY KEY,
    "nodeNum" BIGINT NOT NULL,
    enabled BOOLEAN DEFAULT true,
    "createdAt" BIGINT NOT NULL,
    "sourceId" TEXT,
    UNIQUE("nodeNum", "sourceId")
  );
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
  );
  CREATE TABLE news_cache (
    id SERIAL PRIMARY KEY,
    "feedData" TEXT NOT NULL,
    "fetchedAt" BIGINT NOT NULL,
    "sourceUrl" TEXT NOT NULL
  );
  CREATE TABLE user_news_status (
    id SERIAL PRIMARY KEY,
    "userId" INTEGER NOT NULL,
    "lastSeenNewsId" TEXT,
    "dismissedNewsIds" TEXT,
    "updatedAt" BIGINT NOT NULL
  );
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
  DROP TABLE IF EXISTS user_news_status;
  DROP TABLE IF EXISTS news_cache;
  DROP TABLE IF EXISTS upgrade_history;
  DROP TABLE IF EXISTS auto_traceroute_nodes;
  DROP TABLE IF EXISTS solar_estimates;
  CREATE TABLE solar_estimates (
    id SERIAL PRIMARY KEY,
    timestamp BIGINT NOT NULL,
    watt_hours DOUBLE NOT NULL,
    fetched_at BIGINT NOT NULL,
    created_at BIGINT,
    UNIQUE (timestamp)
  );
  CREATE TABLE auto_traceroute_nodes (
    id SERIAL PRIMARY KEY,
    nodeNum BIGINT NOT NULL,
    enabled BOOLEAN DEFAULT true,
    createdAt BIGINT NOT NULL,
    sourceId VARCHAR(64),
    UNIQUE(nodeNum, sourceId)
  );
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
  );
  CREATE TABLE news_cache (
    id SERIAL PRIMARY KEY,
    feedData MEDIUMTEXT NOT NULL,
    fetchedAt BIGINT NOT NULL,
    sourceUrl VARCHAR(512) NOT NULL
  );
  CREATE TABLE user_news_status (
    id SERIAL PRIMARY KEY,
    userId INT NOT NULL,
    lastSeenNewsId VARCHAR(128),
    dismissedNewsIds TEXT,
    updatedAt BIGINT NOT NULL
  );
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

const ALL_TABLES = [
  'solar_estimates',
  'auto_traceroute_nodes',
  'upgrade_history',
  'news_cache',
  'user_news_status',
  'backup_history',
];

/**
 * Shared test suite that runs against any backend.
 */
function runMiscTests(getBackend: () => TestBackend) {
  let repo: MiscRepository;

  beforeEach(() => {
    const backend = getBackend();
    if (!backend.available) return;
    repo = new MiscRepository(backend.drizzleDb, backend.dbType);
  });

  // ============ SOLAR ESTIMATES ============

  it('upsertSolarEstimate - insert and retrieve', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const now = Date.now();
    await repo.upsertSolarEstimate({ timestamp: now, watt_hours: 1500.5, fetched_at: now });

    const results = await repo.getRecentSolarEstimates();
    expect(results).toHaveLength(1);
    expect(results[0].watt_hours).toBeCloseTo(1500.5);
    expect(results[0].timestamp).toBe(now);
  });

  it('upsertSolarEstimate - updates existing record on conflict', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const ts = Date.now();
    await repo.upsertSolarEstimate({ timestamp: ts, watt_hours: 1000, fetched_at: ts });
    await repo.upsertSolarEstimate({ timestamp: ts, watt_hours: 2000, fetched_at: ts + 1000 });

    const results = await repo.getRecentSolarEstimates();
    expect(results).toHaveLength(1);
    expect(results[0].watt_hours).toBeCloseTo(2000);
  });

  it('getRecentSolarEstimates - returns most recent first, respects limit', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const base = Date.now();
    for (let i = 0; i < 5; i++) {
      await repo.upsertSolarEstimate({ timestamp: base + i * 1000, watt_hours: i * 100, fetched_at: base });
    }

    const all = await repo.getRecentSolarEstimates(5);
    expect(all).toHaveLength(5);
    // Most recent first
    expect(all[0].timestamp).toBeGreaterThan(all[1].timestamp);

    const limited = await repo.getRecentSolarEstimates(2);
    expect(limited).toHaveLength(2);
  });

  it('getSolarEstimatesInRange - returns only records in range', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const base = 1000000;
    await repo.upsertSolarEstimate({ timestamp: base, watt_hours: 100, fetched_at: base });
    await repo.upsertSolarEstimate({ timestamp: base + 1000, watt_hours: 200, fetched_at: base });
    await repo.upsertSolarEstimate({ timestamp: base + 2000, watt_hours: 300, fetched_at: base });
    await repo.upsertSolarEstimate({ timestamp: base + 3000, watt_hours: 400, fetched_at: base });

    const results = await repo.getSolarEstimatesInRange(base + 500, base + 2500);
    expect(results).toHaveLength(2);
    results.forEach(r => {
      expect(r.timestamp).toBeGreaterThanOrEqual(base + 500);
      expect(r.timestamp).toBeLessThanOrEqual(base + 2500);
    });
  });

  // ============ AUTO-TRACEROUTE NODES ============

  it('getAutoTracerouteNodes - empty initially', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const nodes = await repo.getAutoTracerouteNodes();
    expect(nodes).toHaveLength(0);
  });

  it('setAutoTracerouteNodes - replaces all entries', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    await repo.setAutoTracerouteNodes([100, 200, 300]);
    let nodes = await repo.getAutoTracerouteNodes();
    expect(nodes).toHaveLength(3);
    expect(nodes.sort()).toEqual([100, 200, 300]);

    // Replace with different set
    await repo.setAutoTracerouteNodes([400, 500]);
    nodes = await repo.getAutoTracerouteNodes();
    expect(nodes).toHaveLength(2);
    expect(nodes.sort()).toEqual([400, 500]);
  });

  it('setAutoTracerouteNodes - empty array clears all', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    await repo.setAutoTracerouteNodes([100, 200]);
    await repo.setAutoTracerouteNodes([]);
    const nodes = await repo.getAutoTracerouteNodes();
    expect(nodes).toHaveLength(0);
  });

  it('addAutoTracerouteNode - adds single node', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    await repo.addAutoTracerouteNode(12345);
    const nodes = await repo.getAutoTracerouteNodes();
    expect(nodes).toContain(12345);
  });

  it('addAutoTracerouteNode - idempotent for duplicate', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    await repo.addAutoTracerouteNode(12345);
    await repo.addAutoTracerouteNode(12345); // Should not throw
    const nodes = await repo.getAutoTracerouteNodes();
    expect(nodes.filter(n => n === 12345)).toHaveLength(1);
  });

  it('removeAutoTracerouteNode - removes specific node', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    await repo.setAutoTracerouteNodes([100, 200, 300]);
    await repo.removeAutoTracerouteNode(200);
    const nodes = await repo.getAutoTracerouteNodes();
    expect(nodes).not.toContain(200);
    expect(nodes).toHaveLength(2);
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

  // ============ NEWS CACHE ============

  it('saveNewsCache and getNewsCache - save and retrieve', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const now = Date.now();
    await repo.saveNewsCache({
      feedData: JSON.stringify({ items: ['news1', 'news2'] }),
      fetchedAt: now,
      sourceUrl: 'https://example.com/feed',
    });

    const cached = await repo.getNewsCache();
    expect(cached).not.toBeNull();
    expect(cached!.sourceUrl).toBe('https://example.com/feed');
    expect(JSON.parse(cached!.feedData)).toEqual({ items: ['news1', 'news2'] });
  });

  it('getNewsCache - returns null when empty', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const result = await repo.getNewsCache();
    expect(result).toBeNull();
  });

  it('saveNewsCache - replaces previous cache', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const now = Date.now();
    await repo.saveNewsCache({ feedData: '{"old": true}', fetchedAt: now, sourceUrl: 'https://old.com/feed' });
    await repo.saveNewsCache({ feedData: '{"new": true}', fetchedAt: now + 1000, sourceUrl: 'https://new.com/feed' });

    const cached = await repo.getNewsCache();
    expect(cached!.sourceUrl).toBe('https://new.com/feed');
    expect(JSON.parse(cached!.feedData)).toEqual({ new: true });
  });

  // ============ USER NEWS STATUS ============

  it('saveUserNewsStatus and getUserNewsStatus - create and retrieve', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const now = Date.now();
    await repo.saveUserNewsStatus({ userId: 1, lastSeenNewsId: 'news-123', dismissedNewsIds: '["news-111"]', updatedAt: now });

    const status = await repo.getUserNewsStatus(1);
    expect(status).not.toBeNull();
    expect(status!.userId).toBe(1);
    expect(status!.lastSeenNewsId).toBe('news-123');
  });

  it('getUserNewsStatus - returns null for missing user', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const result = await repo.getUserNewsStatus(99999);
    expect(result).toBeNull();
  });

  it('saveUserNewsStatus - updates existing record', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const now = Date.now();
    await repo.saveUserNewsStatus({ userId: 1, lastSeenNewsId: 'news-001', updatedAt: now });
    await repo.saveUserNewsStatus({ userId: 1, lastSeenNewsId: 'news-999', updatedAt: now + 1000 });

    const status = await repo.getUserNewsStatus(1);
    expect(status!.lastSeenNewsId).toBe('news-999');
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
describe('MiscRepository - SQLite Backend', () => {
  let backend: TestBackend;

  beforeEach(() => {
    backend = createSqliteBackend(SQLITE_CREATE);
  });

  afterEach(async () => {
    await backend.close();
  });

  runMiscTests(() => backend);
});

// --- PostgreSQL Backend ---
describe.skipIf(!postgresAvailable)('MiscRepository - PostgreSQL Backend', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE);
    if (backend.available) {
      console.log('✓ PostgreSQL connection established for misc tests');
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

  runMiscTests(() => backend);
});

// --- MySQL Backend ---
describe.skipIf(!mysqlAvailable)('MiscRepository - MySQL Backend', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE);
    if (backend.available) {
      console.log('✓ MySQL connection established for misc tests');
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

  runMiscTests(() => backend);
});
